#!/usr/bin/env node
/**
 * make-p2p-tiktok.mjs — render vertical TikTok/Reels demos of the P2P flow.
 *
 * Real UI only: every step is an app screenshot, so amounts, statuses and
 * account details are the app's own pixels (no AI-hallucinated UI text).
 *
 * Variants:
 *   --lang=zh --rail=wechat   Chinese, BIG → CNY, WeChat (default)
 *   --lang=zh --rail=paypal   Chinese, BIG → USD, PayPal
 *   --lang=en --rail=wechat   English, BIG → CNY, WeChat
 *
 * Each run writes (docs/p2p-demo/assets/tiktok/):
 *   <name>.mp4           1080x1920, 30 fps, ~33 s, captions + voiceover
 *   <name>.srt           sidecar captions
 *   <name>-cover.png     vertical cover
 *   <name>.caption.txt   ready-to-paste TikTok title/description/hashtags
 *
 * Usage:
 *   node e2e/make-p2p-tiktok.mjs
 *   node e2e/make-p2p-tiktok.mjs --lang=zh --rail=paypal
 *   node e2e/make-p2p-tiktok.mjs --lang=en --rail=wechat
 *   FFMPEG=/path/to/ffmpeg EDGE_TTS=/path/to/edge-tts node e2e/make-p2p-tiktok.mjs
 *   node e2e/make-p2p-tiktok.mjs --no-voice   # captions only
 *
 * Requirements: ffmpeg (PATH, ffmpeg-static, or FFMPEG). Voiceover additionally
 * needs `edge-tts` (pip install edge-tts) or EDGE_TTS; without it the video is
 * rendered with captions only.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs/p2p-demo/assets/screenshots');
const OUT_DIR = join(ROOT, 'docs/p2p-demo/assets/tiktok');
const FONT_DIR = '/usr/share/fonts';
const W = 1080;
const H = 1920;
const FPS = 30;
const HOOK = 3;
const PROBLEM = 3;
const STEP = 3;
const CTA = 3;
const STEPS_START = HOOK + PROBLEM;
const CTA_START = STEPS_START + STEP * 8;
const TOTAL = CTA_START + CTA;
const DURATIONS = [HOOK, PROBLEM, ...Array(8).fill(STEP), CTA];

const require = createRequire(import.meta.url);
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try { return require('ffmpeg-static'); } catch {}
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();
const EDGE_TTS = process.env.EDGE_TTS || 'edge-tts';

const STEP_SLUGS = [
  '02-order', '03-match', '06-escrow-locked', '08-instructions',
  '10-payment-claimed', '11-seller-confirm', '13-escrow-released', '14-completed',
];

const CONFIGS = {
  'zh:wechat': {
    lang: 'zh', prefix: 'p2p-cny-wechat', out: 'p2p-tiktok.zh',
    font: 'Noto Sans CJK SC', capSize: 40, problemSize: 94, problemSubSize: 44,
    ctaSize: 92, ctaSubSize: 54, ctaLinkSize: 58,
    voice: 'zh-CN-XiaoxiaoNeural', rate: '+8%',
    chip: 'P2P 演示',
    hook: { big: 'BIG → CNY', sub: '无需银行 · 2 分钟完成', small: 'P2P 场外交易 · 链上托管' },
    problem: { big: '担心付款后\\N对方不放币？', sub: '2-of-3 托管：谁都不能单独动钱', small: '平台只做共同签名' },
    caps: [
      '1/8 卖家挂单：10,000 BIG = 100 CNY',
      '2/8 买家下单，锁定金额和收款地址',
      '3/8 BIG 锁进 2-of-3 托管',
      '4/8 买家拿到金额和专属备注码',
      '5/8 买家付款并提交微信流水号',
      '6/8 卖家核对金额、备注、流水号',
      '7/8 卖家释放，平台共同签名',
      '8/8 完成：BIG 到买家，人民币到卖家',
    ],
    cta: { big: '全程链上托管', sub: '平台不碰你的钱', link: '打开钱包 → P2P', small: '演示 · 非投资建议' },
    voiceLines: [
      'BIG 换人民币，不用银行卡。',
      '担心对方不释放？',
      '卖家挂单，一万 BIG。',
      '买家下单。',
      'BIG 锁进托管。',
      '买家拿到付款信息。',
      '付款，提交流水号。',
      '卖家核对到账。',
      '卖家释放，平台签名。',
      '完成，币到买家。',
      '全程托管，平台不碰钱。',
    ],
    caption: ['标题：BIG → CNY，2 分钟看懂 P2P 法币交易', '',
      '8 步看懂：卖家挂单 → 买家下单 → BIG 锁进 2-of-3 托管 → 买家拿到付款信息 → 买家付款并提交流水号 → 卖家核对账单 → 卖家释放 → 完成。',
      '全程链上托管，平台不碰你的钱。演示非投资建议。', '',
      '#Bigtangle #P2P #加密货币 #法币 #Web3 #金融科技 #BIG #CNY'],
  },
  'zh:paypal': {
    lang: 'zh', prefix: 'p2p-paypal', out: 'p2p-tiktok-paypal.zh',
    font: 'Noto Sans CJK SC', capSize: 40, problemSize: 94, problemSubSize: 44,
    ctaSize: 92, ctaSubSize: 54, ctaLinkSize: 58,
    voice: 'zh-CN-XiaoxiaoNeural', rate: '+8%',
    chip: 'P2P 演示',
    hook: { big: 'BIG → USD', sub: 'PayPal 美元 · 2 分钟完成', small: 'P2P 场外交易 · 链上托管' },
    problem: { big: '担心付款后\\N对方不放币？', sub: '2-of-3 托管：谁都不能单独动钱', small: '平台只做共同签名' },
    caps: [
      '1/8 卖家挂单：10,000 BIG = 100 USD',
      '2/8 买家下单，锁定金额和收款地址',
      '3/8 BIG 锁进 2-of-3 托管',
      '4/8 买家拿到 PayPal 付款信息',
      '5/8 买家付款并提交 PayPal 交易号',
      '6/8 卖家核对 PayPal 到账',
      '7/8 卖家释放，平台共同签名',
      '8/8 完成：BIG 到买家，美元到卖家',
    ],
    cta: { big: '全程链上托管', sub: '平台不碰你的钱', link: '打开钱包 → P2P', small: '演示 · 非投资建议' },
    voiceLines: [
      'BIG 换美元，用 PayPal。',
      '担心对方不释放？',
      '卖家挂单，一万 BIG。',
      '买家下单。',
      'BIG 锁进托管。',
      '买家拿到 PayPal 付款信息。',
      '用 PayPal 付款，提交交易号。',
      '卖家核对 PayPal 到账。',
      '卖家释放，平台签名。',
      '完成，美元到卖家。',
      '全程托管，平台不碰钱。',
    ],
    caption: ['标题：BIG → USD，用 PayPal 2 分钟搞定', '',
      '8 步看懂 PayPal 美元 P2P：卖家挂单 → 买家下单 → BIG 锁进 2-of-3 托管 → 买家拿到 PayPal 邮箱和备注码 → 付款并提交交易号 → 卖家核对 PayPal 到账 → 卖家释放 → 完成。',
      '全程链上托管，平台不碰你的钱。演示非投资建议。', '',
      '#Bigtangle #P2P #PayPal #USD #加密货币 #法币 #Web3 #金融科技'],
  },
  'en:wechat': {
    lang: 'en', prefix: 'p2p-en', out: 'p2p-tiktok.en',
    font: 'DejaVu Sans', capSize: 36, problemSize: 82, problemSubSize: 34,
    ctaSize: 84, ctaSubSize: 46, ctaLinkSize: 52,
    voice: 'en-US-AriaNeural', rate: '+12%',
    chip: 'P2P demo',
    hook: { big: 'BIG → CNY', sub: 'No bank · 2 minutes', small: 'P2P · on-chain escrow' },
    problem: { big: "Worried the seller\\Nwon't release?", sub: '2-of-3 escrow: no single party can move funds', small: 'The platform only co-signs' },
    caps: [
      '1/8 Seller posts: 10,000 BIG = 100 CNY',
      '2/8 Buyer orders; amount and address locked',
      '3/8 BIG locked in 2-of-3 escrow',
      '4/8 Buyer gets the amount and note code',
      '5/8 Buyer pays, submits the transfer ID',
      '6/8 Seller checks amount, note and ID',
      '7/8 Seller releases; platform co-signs',
      '8/8 Done: BIG to buyer, CNY to seller',
    ],
    cta: { big: 'On-chain escrow', sub: 'The platform never touches your money', link: 'Open wallet → P2P', small: 'Demo · not investment advice' },
    voiceLines: [
      'Swap BIG for cash. No bank needed.',
      'Worried the seller will not release?',
      'Seller posts ten thousand BIG.',
      'Buyer places the order.',
      'BIG is locked in escrow.',
      'Buyer gets payment details.',
      'Buyer pays and submits the ID.',
      'Seller checks the statement.',
      'Seller releases; platform co-signs.',
      'Done. BIG to buyer.',
      'On-chain escrow. Funds stay yours.',
    ],
    caption: ['Title: BIG → CNY in 2 minutes', '',
      '8 steps: seller posts → buyer orders → BIG locked in 2-of-3 escrow → buyer gets the amount and note code → buyer pays and submits the transfer ID → seller checks the statement → seller releases → done.',
      'On-chain escrow. The platform never touches your money. Demo, not investment advice.', '',
      '#Bigtangle #P2P #Crypto #Fiat #Web3 #Fintech #BIG #CNY'],
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const pick = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
  };
  const lang = pick('lang', 'zh');
  const rail = pick('rail', 'wechat');
  const cfg = CONFIGS[`${lang}:${rail}`];
  if (!cfg) {
    throw new Error(`unknown variant ${lang}:${rail} (use zh:wechat, zh:paypal, en:wechat)`);
  }
  return { cfg, noVoice: args.includes('--no-voice') || args.includes('--silent') };
}

function run(args) {
  try {
    execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e.stderr?.toString().trim().split('\n').slice(-8).join('\n') || e.message;
    throw new Error(`ffmpeg failed:\n${err}`);
  }
}

function probeDuration(file) {
  try {
    execFileSync(FFMPEG, ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const m = (e.stderr?.toString() || '').match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

function ts(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function srtTs(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function shot(cfg, n, slug) {
  return `${cfg.prefix}-${n}-${slug}-${cfg.lang}.png`;
}

function srtCues(cfg) {
  const cues = [
    [0, HOOK, `${cfg.lang === 'en' ? 'BIG → CNY' : 'BIG → CNY'}\\n${cfg.hook.sub}`],
    [HOOK, HOOK + PROBLEM, `${cfg.problem.big.replace(/\\N/g, '\\n')}\\n${cfg.problem.sub}`],
  ];
  for (let i = 0; i < cfg.caps.length; i++) {
    const a = STEPS_START + i * STEP;
    cues.push([a, a + STEP, cfg.caps[i]]);
  }
  cues.push([CTA_START, TOTAL, `${cfg.cta.big} · ${cfg.cta.sub}\\n${cfg.cta.link} · ${cfg.cta.small}`]);
  return cues;
}

function buildAss(cfg) {
  const event = (a, b, style, text, extra = '') =>
    `Dialogue: 0,${ts(a)},${ts(b)},${style},,0,0,0,,{\\fad(160,160)${extra}}${text}`;
  const lines = [];
  lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  lines.push(
    `Style: Cap,${cfg.font},${cfg.capSize},&H00FFFFFF,&H000000FF,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,10,0,7,36,36,164,1`,
    `Style: Chip,${cfg.font},30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1`,
    `Style: Hook,${cfg.font},136,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: HookSub,${cfg.font},54,&H0062D4A8,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: HookSmall,${cfg.font},32,&H00DDDDDD,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Problem,${cfg.font},${cfg.problemSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: ProblemSub,${cfg.font},${cfg.problemSubSize},&H0062D4A8,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Cta,${cfg.font},${cfg.ctaSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: CtaSub,${cfg.font},${cfg.ctaSubSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: CtaLink,${cfg.font},${cfg.ctaLinkSize},&H0062D4A8,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: CtaSmall,${cfg.font},30,&H00AAAAAA,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Brand,${cfg.font},28,&H00888888,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,9,0,0,0,1`,
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );
  lines.push(event(0, HOOK, 'Hook', cfg.hook.big, '\\pos(540,760)'));
  lines.push(event(0.15, HOOK, 'HookSub', cfg.hook.sub, '\\pos(540,910)'));
  lines.push(event(0.3, HOOK, 'HookSmall', cfg.hook.small, '\\pos(540,1010)'));
  lines.push(event(HOOK, HOOK + PROBLEM, 'Problem', cfg.problem.big, '\\pos(540,760)'));
  lines.push(event(HOOK + 0.15, HOOK + PROBLEM, 'ProblemSub', cfg.problem.sub, '\\pos(540,980)'));
  lines.push(event(HOOK + 0.3, HOOK + PROBLEM, 'HookSmall', cfg.problem.small, '\\pos(540,1050)'));
  lines.push(event(STEPS_START, CTA_START, 'Brand', 'bigt.ai', '\\pos(1030,62)'));
  for (let i = 0; i < cfg.caps.length; i++) {
    const a = STEPS_START + i * STEP;
    lines.push(event(a, a + STEP, 'Chip', `{\\c&H62D4A8&}●{\\c&HFFFFFF&} ${cfg.chip} · ${i + 1}/8`, '\\pos(44,62)'));
    lines.push(event(a, a + STEP, 'Cap', cfg.caps[i]));
  }
  lines.push(event(CTA_START, TOTAL, 'Cta', cfg.cta.big, '\\pos(540,780)'));
  lines.push(event(CTA_START + 0.15, TOTAL, 'CtaSub', cfg.cta.sub, '\\pos(540,930)'));
  lines.push(event(CTA_START + 0.3, TOTAL, 'CtaLink', cfg.cta.link, '\\pos(540,1060)'));
  lines.push(event(CTA_START + 0.45, TOTAL, 'CtaSmall', cfg.cta.small, '\\pos(540,1160)'));
  return lines.join('\n') + '\n';
}

function segment(img, seconds, dark, font, out) {
  const frames = Math.round(seconds * FPS);
  const vf = dark
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `gblur=sigma=60,eq=brightness=-0.72:saturation=0.45,` +
      `zoompan=z='min(1.0+0.0005*on,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`
    : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `gblur=sigma=40,eq=brightness=-0.35:saturation=0.7[bg];` +
      `[0:v]scale=-2:${H}[fg];` +
      `[bg][fg]overlay=(W-w)/2:0,` +
      `zoompan=z='min(1.0+0.0006*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`;
  run(['-y', '-loop', '1', '-i', img, '-filter_complex', vf, '-map', '[v]',
    '-frames:v', String(frames), '-r', String(FPS), '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', out]);
}

/** Generate one TTS clip per segment, fit it into the segment window. */
function buildVoice(cfg, tmp) {
  try {
    execFileSync(EDGE_TTS, ['--help'], { stdio: 'ignore' });
  } catch {
    console.warn('· edge-tts not found — rendering without voiceover');
    return null;
  }
  const wavs = [];
  for (let i = 0; i < cfg.voiceLines.length; i++) {
    const mp3 = join(tmp, `voice-${i}.mp3`);
    const wav = join(tmp, `voice-${i}.wav`);
    try {
      execFileSync(EDGE_TTS, ['--voice', cfg.voice, `--rate=${cfg.rate}`,
        '--text', cfg.voiceLines[i], '--write-media', mp3], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.warn(`· TTS failed for line ${i + 1} — rendering without voiceover`);
      return null;
    }
    const dur = probeDuration(mp3);
    const target = DURATIONS[i];
    const factor = Math.min(1.35, Math.max(1, dur / Math.max(0.5, target - 0.3)));
    if (dur > target - 0.15) console.log(`· line ${i + 1}: ${dur.toFixed(2)}s → atempo ${factor.toFixed(2)}`);
    run(['-y', '-i', mp3, '-af', `atempo=${factor.toFixed(3)},apad,atrim=0:${target}`,
      '-ar', '48000', '-ac', '1', wav]);
    wavs.push(wav);
  }
  const list = join(tmp, 'voice.txt');
  writeFileSync(list, wavs.map((p) => `file '${p}'`).join('\n') + '\n');
  const voice = join(tmp, 'voice.wav');
  run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', voice]);
  return voice;
}

function main() {
  const { cfg, noVoice } = parseArgs();
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); }
  catch { throw new Error(`ffmpeg not found (${FFMPEG}); set FFMPEG or install ffmpeg-static`); }
  const files = [
    shot(cfg, '02', 'order'), shot(cfg, '03', 'match'), shot(cfg, '06', 'escrow-locked'),
    shot(cfg, '08', 'instructions'), shot(cfg, '10', 'payment-claimed'),
    shot(cfg, '11', 'seller-confirm'), shot(cfg, '13', 'escrow-released'), shot(cfg, '14', 'completed'),
  ];
  for (const f of files) {
    try { statSync(join(SHOTS, f)); }
    catch { throw new Error(`missing screenshot ${f}; capture this variant first`); }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'p2p-tiktok-'));
  const segs = [];
  const push = (name, img, seconds, dark) => {
    const out = join(tmp, `${name}.mp4`);
    segment(join(SHOTS, img), seconds, dark, cfg.font, out);
    segs.push(out);
    console.log(`· ${name} (${seconds}s)`);
  };
  push('00-hook', files[0], HOOK, true);
  push('01-problem', files[5], PROBLEM, true);
  for (let i = 0; i < 8; i++) push(`1${i}-step-${i + 1}`, files[i], STEP, false);
  push('30-cta', files[7], CTA, true);

  const list = join(tmp, 'segments.txt');
  writeFileSync(list, segs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const base = join(tmp, 'base.mp4');
  run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', base]);

  const ass = join(tmp, 'captions.ass');
  writeFileSync(ass, buildAss(cfg));
  const srt = join(OUT_DIR, `${cfg.out}.srt`);
  writeFileSync(srt, srtCues(cfg).map(([a, b, text], i) =>
    `${i + 1}\n${srtTs(a)} --> ${srtTs(b)}\n${text.replace(/\\[Nn]/g, '\n')}\n`).join('\n'));

  const voice = noVoice ? null : buildVoice(cfg, tmp);
  const stepEnd = CTA_START;
  const filters = [
    `drawbox=x=0:y=0:w=${W}:h=150:color=0x0B1714:t=fill:enable='between(t,${STEPS_START},${stepEnd})'`,
    `drawbox=x=0:y=147:w=${W}:h=3:color=0x00E0A4@0.8:t=fill:enable='between(t,${STEPS_START},${stepEnd})'`,
    `drawbox=x=0:y=0:w=${W}:h=8:color=white@0.14:t=fill:enable='between(t,${STEPS_START},${stepEnd})'`,
  ];
  for (let i = 0; i < 8; i++) {
    const at = STEPS_START + i * STEP;
    const w = Math.round((W / 8) * (i + 1));
    filters.push(`drawbox=x=0:y=0:w=${w}:h=8:color=0x00E0A4@0.95:t=fill:enable='gte(t,${at})*lt(t,${stepEnd})'`);
  }
  filters.push(`subtitles=${ass.replace(/([:'\\ ])/g, '\\$1')}:fontsdir=${FONT_DIR}`, 'format=yuv420p');
  const mp4 = join(OUT_DIR, `${cfg.out}.mp4`);
  const args = ['-y', '-i', base];
  if (voice) args.push('-i', voice);
  const sineInputs = voice ? [2, 3, 4] : [1, 2, 3];
  if (voice || !noVoice) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=110:duration=${TOTAL}:sample_rate=48000`,
      '-f', 'lavfi', '-i', `sine=frequency=164.81:duration=${TOTAL}:sample_rate=48000`,
      '-f', 'lavfi', '-i', `sine=frequency=220:duration=${TOTAL}:sample_rate=48000`);
    const bed = `[${sineInputs[0]}:a][${sineInputs[1]}:a][${sineInputs[2]}:a]amix=inputs=3:normalize=0,` +
      `tremolo=f=0.14:d=0.35,lowpass=f=900,volume=${voice ? '0.09' : '0.4'},` +
      `afade=t=in:d=1.2,afade=t=out:st=${TOTAL - 2}:d=2[bed]`;
    const audio = voice
      ? `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[voice];${bed};[voice][bed]amix=inputs=2:normalize=0:duration=first[a]`
      : `${bed};[bed]anull[a]`;
    args.push('-filter_complex', `[0:v]${filters.join(',')}[v];${audio}`, '-map', '[v]', '-map', '[a]',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  } else {
    args.push('-vf', filters.join(','), '-map', '0:v', '-an');
  }
  args.push('-t', String(TOTAL), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4);
  run(args);

  writeFileSync(join(OUT_DIR, `${cfg.out}.caption.txt`), cfg.caption.join('\n') + '\n');
  const cover = join(OUT_DIR, `${cfg.out}-cover.png`);
  run(['-y', '-ss', '0.8', '-i', mp4, '-frames:v', '1', cover]);

  const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`\n✓ ${mp4} (${mb(mp4)})`);
  console.log(`✓ ${cover}`);
  console.log(`✓ ${srt}`);
  console.log(`✓ ${join(OUT_DIR, `${cfg.out}.caption.txt`)}`);
  console.log(`variant ${cfg.lang}:${cfg.prefix.includes('paypal') ? 'paypal' : 'wechat'} · ${TOTAL}s · ${W}x${H} · ${FPS}fps${voice ? ' · voiceover' : ' · captions only'}`);
  rmSync(tmp, { recursive: true, force: true });
}

try { main(); } catch (e) { console.error('\nmake-p2p-tiktok failed:', e.message); process.exit(1); }
