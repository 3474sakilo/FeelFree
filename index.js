import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import {
  Keypair, Connection, PublicKey, LAMPORTS_PER_SOL,
  TransactionMessage, VersionedTransaction, SystemProgram
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createTransferInstruction,
  createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
  createInitializeMultisigInstruction, MULTISIG_SIZE
} from '@solana/spl-token';
import bs58 from 'bs58';
import crypto from 'crypto';
import NodeCache from 'node-cache';

// ===== CONFIG =====
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const KEY = process.env.FEE_PAYER_PRIVATE_KEY;
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = process.env.PORT || 3000;

if (!TOKEN || !KEY) {
  console.log('ERROR: Missing env vars');
  process.exit(1);
}

// ===== EXPRESS =====
const app = express();
app.get('/', (_, r) => r.send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`WEB:${PORT}`));

// ===== FEE PAYER =====
let feePayer;
try {
  const k = KEY.trim();
  feePayer = k.startsWith('[')
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(k)))
    : Keypair.fromSecretKey(bs58.decode(k));
} catch {
  console.log('BAD KEY');
  process.exit(1);
}

const FPA = feePayer.publicKey.toBase58();
const MAINNET = RPC.includes('mainnet');
const conn = new Connection(RPC, 'confirmed');
console.log(`FEE:${FPA.slice(0, 8)} NET:${MAINNET ? 'MAIN' : 'DEV'}`);

// Log fee payer balance at startup — if this is 0 the bot cannot create vaults.
conn.getBalance(feePayer.publicKey).then(b => {
  console.log(`FEE_PAYER_BAL: ${(b / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  if (b < 0.01 * LAMPORTS_PER_SOL)
    console.warn(`WARNING: fee payer balance is very low — fund ${FPA} or vault creation will fail`);
}).catch(() => {});

// ===== STORAGE =====
const cache = new NodeCache({ stdTTL: 0 });
const txCache = new NodeCache({ stdTTL: 300 });
const used = new Map();

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of used) if (n - v > 300000) used.delete(k);
}, 60000);

// ===== TX HELPER =====
async function sendAndConfirm(tx, blockhash, lastValidBlockHeight) {
  try {
    const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    return sig;
  } catch (e) {
    const logs = e?.logs ?? (typeof e?.getLogs === 'function' ? await e.getLogs(conn).catch(() => []) : []);
    if (logs?.length) throw new Error('TX failed:\n' + logs.join('\n'));
    throw e;
  }
}

// ===== MULTISIG HELPER =====
async function createMultisigOnChain(userPublicKey) {
  const [rent, fpBal] = await Promise.all([
    conn.getMinimumBalanceForRentExemption(MULTISIG_SIZE),
    conn.getBalance(feePayer.publicKey)
  ]);

  const needed = rent + 5000;
  if (fpBal < needed) {
    throw new Error(
      `Fee payer needs at least ${(needed / LAMPORTS_PER_SOL).toFixed(6)} SOL to create a vault.\n` +
      `Current balance: ${(fpBal / LAMPORTS_PER_SOL).toFixed(6)} SOL\n` +
      `Fund this address: ${FPA}`
    );
  }

  const ms = Keypair.generate();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: feePayer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: feePayer.publicKey,
          newAccountPubkey: ms.publicKey,
          lamports: rent,
          space: MULTISIG_SIZE,
          programId: TOKEN_PROGRAM_ID
        }),
        createInitializeMultisigInstruction(
          ms.publicKey,
          [userPublicKey, feePayer.publicKey],
          2
        )
      ]
    }).compileToV0Message()
  );

  tx.sign([feePayer, ms]);
  await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
  return ms.publicKey;
}

// ===== VAULT =====
async function createVault(uid) {
  const seed = crypto.createHash('sha256').update(uid + Date.now() + Math.random()).digest();
  const user = Keypair.fromSeed(seed.slice(0, 32));
  const msPublicKey = await createMultisigOnChain(user.publicKey);

  const w = {
    pk: user.publicKey.toBase58(),
    sk: bs58.encode(user.secretKey),
    ms: msPublicKey.toBase58(),
    uid: String(uid),
    label: 'Vault-' + user.publicKey.toBase58().slice(0, 8),
    fp: FPA
  };
  cache.set(w.pk, w);
  return w;
}

async function convertVault(uid, pkey) {
  let user;
  try {
    const k = pkey.trim();
    user = k.startsWith('[')
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(k)))
      : Keypair.fromSecretKey(bs58.decode(k));
  } catch { throw new Error('Bad key format'); }

  if (user.publicKey.toBase58() === FPA) throw new Error('Cannot convert fee payer');

  const msPublicKey = await createMultisigOnChain(user.publicKey);

  const w = {
    pk: user.publicKey.toBase58(),
    sk: bs58.encode(user.secretKey),
    ms: msPublicKey.toBase58(),
    uid: String(uid),
    label: 'Vault-' + user.publicKey.toBase58().slice(0, 8),
    fp: FPA
  };
  cache.set(w.pk, w);
  return w;
}

function getUserWallets(uid) {
  return cache.keys().map(k => cache.get(k)).filter(w => w && w.uid === String(uid));
}

async function getVaultBal(pk) {
  const w = cache.get(pk);
  const p = new PublicKey(pk);
  const solBal = await conn.getBalance(p).catch(() => 0);

  let tokens = [];
  if (w && w.ms) {
    const msP = new PublicKey(w.ms);
    const toks = await conn.getParsedTokenAccountsByOwner(msP, { programId: TOKEN_PROGRAM_ID })
      .catch(() => ({ value: [] }));
    tokens = toks.value.map(t => ({
      mint: t.account.data.parsed.info.mint,
      amt: t.account.data.parsed.info.tokenAmount.uiAmount
    }));
  }

  return { sol: solBal / LAMPORTS_PER_SOL, tokens };
}

async function getBal(pk) {
  const p = new PublicKey(pk);
  const [sol, toks] = await Promise.all([
    conn.getBalance(p).catch(() => 0),
    conn.getParsedTokenAccountsByOwner(p, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] }))
  ]);
  return {
    sol: sol / LAMPORTS_PER_SOL,
    tokens: toks.value.map(t => ({
      mint: t.account.data.parsed.info.mint,
      amt: t.account.data.parsed.info.tokenAmount.uiAmount
    }))
  };
}

// ===== TRANSACTION BUILDER =====
async function buildTx(from, to, amt, mint) {
  const w = cache.get(from);
  if (!w) throw new Error('Not found');

  const fk = Keypair.fromSecretKey(bs58.decode(w.sk));
  const fp = new PublicKey(from);
  const ms = new PublicKey(w.ms);
  const tp = new PublicKey(to);
  const ixs = [];

  if (mint) {
    const mp = new PublicKey(mint);
    const fa = await getAssociatedTokenAddress(mp, ms, true);
    const ta = await getAssociatedTokenAddress(mp, tp);

    if (!(await conn.getAccountInfo(ta).catch(() => null))) {
      ixs.push(createAssociatedTokenAccountInstruction(feePayer.publicKey, ta, tp, mp));
    }

    ixs.push(createTransferInstruction(
      fa, ta, ms, BigInt(amt),
      [fk.publicKey, feePayer.publicKey]
    ));
  } else {
    ixs.push(SystemProgram.transfer({
      fromPubkey: fp,
      toPubkey: tp,
      lamports: Math.floor(amt * LAMPORTS_PER_SOL)
    }));
  }

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([fk]);

  const ser = Buffer.from(tx.serialize()).toString('base64');
  const id = crypto.createHash('sha256').update(ser).digest('hex').slice(0, 16);
  txCache.set(id, { ser, from, to, amt, mint: mint || null, ts: Date.now() });
  return id;
}

async function submitTx(id) {
  const d = txCache.get(id);
  if (!d) throw new Error('Expired');

  const tx = VersionedTransaction.deserialize(Buffer.from(d.ser, 'base64'));
  const keys = tx.message.getAccountKeys();

  if (keys.get(0).toBase58() !== FPA) throw new Error('Wrong bot');

  for (const ix of tx.message.compiledInstructions) {
    const prog = keys.get(ix.programIndex).toBase58();
    if (prog === '11111111111111111111111111111111') {
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (view.getUint32(0, true) === 2) {
        if (keys.get(ix.accountKeyIndexes[0]).toBase58() === FPA) throw new Error('No drain');
      }
    }
  }

  const s = tx.signatures[0];
  if (s) {
    const sh = Buffer.from(s).toString('hex');
    if (used.has(sh)) throw new Error('Duplicate');
    used.set(sh, Date.now());
  }

  tx.sign([feePayer]);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const sig = await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
  txCache.del(id);

  return {
    sig,
    url: `https://solscan.io/tx/${sig}${MAINNET ? '' : '?cluster=devnet'}`
  };
}

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(TOKEN, { polling: true });
const states = new Map();

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🔐 Create Vault', callback_data: 'create' }],
      [{ text: '🔒 Convert Wallet', callback_data: 'convert' }],
      [{ text: '💎 My Vaults', callback_data: 'wallets' }],
      [{ text: '💸 Send', callback_data: 'send' }],
      [{ text: '📊 Balance', callback_data: 'bal' }],
      [{ text: '🔑 Keys', callback_data: 'keys' }],
      [{ text: '⛽ Status', callback_data: 'status' }],
      [{ text: '🆘 Help', callback_data: 'help' }]
    ]
  }
};

const backBtn = { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main' }]] } };
const cancelBtn = { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } };

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    '🔒 *VAULT BOT*\n\nWallets permanently locked to this bot.\n\n❌ Phantom ❌ Jupiter\n✅ Only this bot',
    { parse_mode: 'Markdown', ...mainMenu }
  ).catch(() => {});
});

bot.on('callback_query', async q => {
  const cid = q.message.chat.id;
  const mid = q.message.message_id;
  const d = q.data;

  bot.answerCallbackQuery(q.id).catch(() => {});

  const ed = (t, kb = {}) =>
    bot.editMessageText(t, { chat_id: cid, message_id: mid, parse_mode: 'Markdown', ...kb }).catch(() => {});

  try {
    if (d === 'main') return ed('🔒 *VAULT BOT*\n\nWallets permanently locked to this bot.', mainMenu);

    if (d === 'create') {
      await ed('⏳ Creating vault on-chain...', {});
      const w = await createVault(String(cid));
      await ed(
        `✅ *Vault Created!*\n\n` +
        `💰 *SOL Address:*\n\`${w.pk}\`\n\n` +
        `🪙 *Token Address:*\n\`${w.ms}\`\n\n` +
        `🔑 *Private Key:*\n\`${w.sk}\`\n\n` +
        `⚠️ Key alone is useless — this bot must co-sign every transaction`,
        backBtn
      );
    }

    else if (d === 'convert') {
      states.set(cid, { action: 'convert' });
      await ed('🔒 Send your private key to lock it to this bot:', cancelBtn);
    }

    else if (d === 'wallets') {
      const ws = getUserWallets(String(cid));
      if (!ws.length) return ed('No vaults', backBtn);

      let t = '*Your Vaults*\n\n';
      const btns = [];
      for (const w of ws) {
        const b = await conn.getBalance(new PublicKey(w.pk)).catch(() => 0);
        t += `${w.label}\n\`${w.pk.slice(0, 12)}...\`\n${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n\n`;
        btns.push([{ text: w.label, callback_data: `det_${w.pk}` }]);
      }
      btns.push([{ text: '🔙 Back', callback_data: 'main' }]);
      await ed(t, { reply_markup: { inline_keyboard: btns } });
    }

    else if (d === 'send') {
      const ws = getUserWallets(String(cid));
      if (!ws.length) return ed('No vaults', backBtn);
      const btns = ws.map(w => [{ text: w.label, callback_data: `sf_${w.pk}` }]);
      btns.push([{ text: '🔙 Back', callback_data: 'main' }]);
      await ed('Select vault to send from:', { reply_markup: { inline_keyboard: btns } });
    }

    else if (d === 'bal') {
      states.set(cid, { action: 'bal' });
      await ed('Send address to check:', cancelBtn);
    }

    else if (d === 'keys') {
      const ws = getUserWallets(String(cid));
      if (!ws.length) return ed('No vaults', backBtn);
      const btns = ws.map(w => [{ text: w.label, callback_data: `ex_${w.pk}` }]);
      btns.push([{ text: '🔙 Back', callback_data: 'main' }]);
      await ed('Select vault:', { reply_markup: { inline_keyboard: btns } });
    }

    else if (d === 'status') {
      const b = await conn.getBalance(feePayer.publicKey).catch(() => 0);
      await ed(
        `⛽ *Status*\n\nFee Payer: \`${FPA.slice(0, 12)}...\`\nBalance: ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\nVaults: ${cache.keys().length}`,
        backBtn
      );
    }

    else if (d === 'help') {
      await ed(
        '*HOW THE VAULT WORKS*\n\n' +
        '2-of-2 multisig enforced on-chain:\n\n' +
        '✅ Your key + this bot = transaction executes\n' +
        '❌ Your key alone = rejected by Solana network\n' +
        '❌ Phantom = missing bot signature → fails\n' +
        '❌ Jupiter = missing bot signature → fails\n' +
        '❌ Other bots = wrong fee payer key → fails\n\n' +
        '*SOL Address* → deposit SOL here\n' +
        '*Token Address* → deposit SPL tokens here',
        backBtn
      );
    }

    else if (d.startsWith('det_')) {
      const pk = d.slice(4);
      const w = cache.get(pk);
      if (!w) return ed('Not found', backBtn);
      const b = await getVaultBal(pk);
      const tokenLines = b.tokens.length
        ? b.tokens.map(t => `${t.amt} \`${t.mint.slice(0, 8)}...\``).join('\n')
        : '_none_';
      await ed(
        `*${w.label}*\n\n` +
        `💰 SOL Address:\n\`${w.pk}\`\n${b.sol.toFixed(4)} SOL\n\n` +
        `🪙 Token Address:\n\`${w.ms}\`\n${tokenLines}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💸 Send SOL', callback_data: `sf_${pk}` }],
              [{ text: '🔑 Show Key', callback_data: `ex_${pk}` }],
              [{ text: '📋 Copy SOL Addr', callback_data: `cp_${pk}` }],
              [{ text: '📋 Copy Token Addr', callback_data: `cpm_${pk}` }],
              [{ text: '🔙 Back', callback_data: 'wallets' }]
            ]
          }
        }
      );
    }

    else if (d.startsWith('sf_')) {
      states.set(cid, { action: 'to', from: d.slice(3) });
      await ed('Enter recipient address:', cancelBtn);
    }

    else if (d.startsWith('ex_')) {
      const w = cache.get(d.slice(3));
      if (w) await ed(
        `🔑 *Private Key*\n\n\`${w.sk}\`\n\n⚠️ Useless without this bot's co-signature\n🗑️ Delete this message after saving`,
        backBtn
      );
    }

    else if (d.startsWith('cp_')) {
      await ed(`\`${d.slice(3)}\``, backBtn);
    }

    else if (d.startsWith('cpm_')) {
      const w = cache.get(d.slice(4));
      if (w) await ed(`\`${w.ms}\``, backBtn);
    }

    else if (d.startsWith('cf_')) {
      const id = d.slice(3);
      const s = states.get(cid);
      if (!s || s.txId !== id) { await ed('Expired', backBtn); states.delete(cid); return; }

      await ed('⏳ Signing and sending...', {});
      const r = await submitTx(id);
      await ed(`✅ *Sent!*\n\n[View on Solscan](${r.url})\n\n${s.amt} SOL sent\nGas sponsored by bot`, backBtn);
      states.delete(cid);
    }

    else if (d === 'cancel') {
      states.delete(cid);
      await ed('🔒 *VAULT BOT*', mainMenu);
    }

  } catch (e) {
    await ed('❌ ' + e.message, backBtn).catch(() => {});
  }
});

bot.on('message', async msg => {
  const cid = msg.chat.id;
  const txt = msg.text;
  if (!txt) return;

  const s = states.get(cid);
  if (!s) return;

  if (txt === '❌ Cancel') {
    states.delete(cid);
    return bot.sendMessage(cid, '🔒 *VAULT BOT*', { parse_mode: 'Markdown', ...mainMenu }).catch(() => {});
  }

  try {
    if (s.action === 'convert') {
      await bot.sendMessage(cid, '⏳ Locking wallet on-chain...', { parse_mode: 'Markdown' });
      const w = await convertVault(String(cid), txt);
      await bot.sendMessage(cid,
        `✅ *Wallet Locked!*\n\n` +
        `💰 SOL Address:\n\`${w.pk}\`\n\n` +
        `🪙 Token Address:\n\`${w.ms}\`\n\n` +
        `🔒 Both addresses now require this bot to co-sign`,
        { parse_mode: 'Markdown', ...backBtn }
      );
      states.delete(cid);
    }

    else if (s.action === 'bal') {
      new PublicKey(txt);
      const b = await getBal(txt);
      await bot.sendMessage(cid,
        `📊 \`${txt.slice(0, 16)}...\`\n💰 ${b.sol.toFixed(4)} SOL`,
        { parse_mode: 'Markdown', ...backBtn }
      );
      states.delete(cid);
    }

    else if (s.action === 'to') {
      new PublicKey(txt);
      s.to = txt;
      s.action = 'amt';
      states.set(cid, s);
      await bot.sendMessage(cid, '💰 Amount in SOL:', cancelBtn);
    }

    else if (s.action === 'amt') {
      const amt = parseFloat(txt);
      if (isNaN(amt) || amt <= 0) return bot.sendMessage(cid, '❌ Invalid amount', cancelBtn);
      s.amt = amt;
      states.set(cid, s);

      const id = await buildTx(s.from, s.to, amt);
      s.txId = id;
      states.set(cid, s);

      await bot.sendMessage(cid,
        `💸 *Confirm Transaction*\n\n` +
        `From: \`${s.from.slice(0, 8)}...\`\n` +
        `To: \`${s.to.slice(0, 8)}...\`\n` +
        `Amount: ${amt} SOL\n` +
        `Gas: sponsored by bot\n\n` +
        `⚠️ Requires 2 signatures (yours + bot)`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Confirm & Send', callback_data: `cf_${id}` },
              { text: '❌ Cancel', callback_data: 'cancel' }
            ]]
          }
        }
      );
    }
  } catch (e) {
    bot.sendMessage(cid, '❌ ' + e.message, cancelBtn).catch(() => {});
  }
});

bot.on('polling_error', err => console.error('POLL ERR:', err.code || err.message));
process.on('unhandledRejection', err => console.error('UNHANDLED:', err));

console.log('✅ BOT READY');