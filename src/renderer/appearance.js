/* ARIA appearance: glass material + background scenes.
 *
 * Owns three things and nothing else:
 *   1. the CSS custom properties that drive the glass material (blur, tint,
 *      style) and the background dim, written on <html>;
 *   2. which background scene is shown (<html data-bg>);
 *   3. the user's custom background image, kept as a Blob in this renderer's
 *      IndexedDB so it never enters the JSON config or crosses IPC.
 *
 * Pure DOM + Web platform; no Node, no IPC. app.js persists the chosen values
 * through aria.config and calls apply() with them. */
(function () {
  'use strict';

  const BACKGROUNDS = [
    { id: 'obsidian', label: 'Obsidian' },
    { id: 'studio', label: 'Studio light' },
    { id: 'eclipse', label: 'Eclipse' },
    { id: 'aurora', label: 'Aurora' },
    { id: 'dusk', label: 'Dusk' },
    { id: 'ocean', label: 'Deep ocean' },
    { id: 'observatory', label: 'Observatory' },
    { id: 'solid', label: 'Solid' },
    { id: 'custom', label: 'Custom image' },
  ];
  const STYLES = ['smoked', 'frosted', 'clear'];
  const DEFAULTS = { background: 'obsidian', glassStyle: 'smoked', glassBlur: 26, glassOpacity: 30, bgDim: 0 };
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const ACCEPTED = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;

  const DB_NAME = 'aria-appearance';
  const STORE = 'files';
  const KEY = 'custom-background';

  let customUrl = null; // current object URL for the custom image
  let current = { ...DEFAULTS };

  // Coarse colour grids of each built-in scene, measured from the real render
  // by scripts/gen-scene-grids.mjs (rerun it after editing scene CSS).
  const SCENE_GRIDS = { w: 20, h: 12, cells: {
      obsidian: '06060706060706060706060807070908080a09090a0a0a0c302c2981766d7f746c3c363214131209090a08080a07070907070806060706060706060706060707070808080a09090b0a0a0c0b0b0d0c0c0e0d0d0f2925245d534d5b524c302c281412120c0c0e0b0b0d0b0b0c0a0a0b08080a07070806060708080909090b0b0b0d0c0c0e0d0d0f0e0e100f0f11101013181718282422282321181716101011181718201e1e1f1d1d1816160f0e100a0a0b08080909090a0f0f101b191a201e1e211e1f1d1b1c171618131214111113121113121113121214131315413c387268606f655d4c443f26221f0e0d0d09090b0a0a0b201e1d4d4540645a5362595149423d2f2a2719161613121417171a17171a1616191515184f484495897e8f83785b524c2d2825100f0e0a0a0b0a0a0b272423695f57988b7f95897d6259513b35311f1b1913121416161a16161a151519141417433d3974696172665e4d453f2622200e0d0e0a0a0b09090a262221655b549184798f83785f564f3a33301e1a191211121313161313161212151212152a26254039364039352e29261715140b0b0c09090a0808091e1c1a4b433e5f564f5e544d47403b2d28251715140e0d0f0f0f120f0f120f0f110e0e111413131c19171b18171412120c0b0c09090a0707090707071411112e292639332f38322e2c27241c1917100f0e0c0b0d0c0c0e0c0c0e0c0c0e0b0b0d0b0b0c0c0b0c0b0b0b09090a0808090707080606070606070b0a0a1714131c19171c19171513120f0d0d1b19183b363336312f1917170a0a0c08080a08080a0707090707080606070606070606070606070606070706070907080a09090a09090808080808092a252470655e655c5525221f0a0a0a0606070606070606070606070606070606070606070606070606070606070606070606070606070606070707081c1918423b373c3631191615070708060607060607060607060607060607060607060607060607',
      studio: '62636e62636e5f606c4d4e583c3d4651525d6768746f707c7677837d7e8a8485918b8c988a8b976e6e797575809b9ba7a5a5b2a1a1ae9b9ba89495a25b5c675b5c6757586444454e3a3b4351515c60616d6768746f707b7677837c7d898384907e7f8b64646e73747f91929f9899a59696a291929f8c8c9955566155566150515b3b3c453939434e4f5a5758635d5e696364706a6b7771717d7778836d6e795858626d6d7884849087879486869282838f7e7e8b4e4f5a4e4f5a48495334353e3839424b4c574f505b51525e5657635c5d6862636e6667735a5b654c4d5763636e72737e74758073748070717d6d6d794546504647513e3f492e2f38363740464752494a54494a554a4b564d4e5851525c53545f47485141414b5555605f606b5f606b5f606b5d5e695a5a6636374036374030313a26272f31313a3c3d473e3f493f404a40414c41424d43444e42434d3738413637404546504a4b564b4c564a4b56494a5448495333333d31323a2728302122292a2a332f303930313a31323a32323c33343d34353e33343d2b2b332d2e373738423b3c463c3d473c3d483d3e473d3e4836374134343e28293124252d2e2f3832333c30313b2f30392e2f382d2e372d2d3629293222232b25262e2b2c352d2e372e2f382f303931323b32333d32333d30313a25252e25252e2f303a32333d32333d31323c31323c30313b2f303a2a2b3323242c2728312c2c352b2c352a2b33292a322929322829322f30392a2b3421222924242c2d2e372f30392f30392f30392f30392f30392e2f3827283223242c292a332e2e382e2f382d2e372c2d362c2d362b2c352a2b3425262f1e1e2622232c292a332a2b342a2b342a2b342a2b342a2b34292a3323242c21222a262731292a342a2b342a2b34292a34292a33292a3325262f2021291b1c2420212925262f25262f25262f25262f25262f25262f24252e2020291f202823242d25262f25262f25262f25262f25262f25262f',
      eclipse: '0203040203040203040203040203040203040203040203040406070b0f110d1315232c2f161b1e030405140c06321b0a160d06040404020304020304020304020304020304020304020304020304020304020304090c0e0c101312191c151c1e07090a0a07042d19091a0f070504040203040203040203040203040203040203040203040203040203040304040506050d1011111518212a2c181f210304051f12072414080a06050203040203040203040203040203040203040203040203040304040a0705160d0721160c251c131f1c181d21210e11120806052b1809160d07030404020304020304020304020304020304020304020304020304060504190f07351d0c4b2d164b311c3d302224221d080707140c062615080d08050203040203040203040203040203040203040203040203040203040404040e09051d11082d1f1330251b312e282123220505051d10072011070806050203040203040203040203040203040203040203040203040203040203040203040304040b0e0e11161720282a1d23250203042213081d100706050402030402030402030402030402030405030405030405030405030404030403030404040515121028201a3a342d342e28120a062514081d10070605040203040203040203040203040203040c04040d04040d04040c04040a040408040408040418110f2c20193c3128352b24140c062012072011070906050203040203040203040203040203041405051506051505051305051105040f05040c04040f0b0b131111181a1a171a1a070707140b062715090e09050203040203040203040203040203041b06051d07051d07051b06051806051505041105040f07080f0d0e0f1214171e200e11130705042c1809160d070304040203040203040203040203042107052508052408052107051d06051806051305040f0505131011131618232c2e1a20220303041e1107251508090705020304020304020304020304',
      aurora: '106b5f127f6d1389751386721277671061580d47450c2d320b18220a0e1d0f0f2718163f251e5d32267b3f2f994a37b4523cc8543dcc4f39be4432a5127b6b14947d15a287159e84148a75116f620f524d0c36380b1d260a0f1e0f10281a17422720613428814231a04e39bd5840d55a41da533dc94735ac127a6a14937c15a187149d83138975116e620f524c0d36380b1d260a0f1e0e0f2618153d241d5b3126783d2e954835af503ac2523bc54c38b84231a110695d127d6c1387731284711175671060570e47440c2d320a17220a0e1c0c0e201312321e194b29216633277e3b2c9241309f4231a13e2f99372a870e4f4a0f5d5510645a1062580f58510e47450d33360b1f270a111e0a0c1a0b0c1c0e0e251513361e194b261e5e2c226e3025783126792e24732921660c31360d3c3e0e42430e41430d393e0c2c330b1e270a121f0a0d1b0a0c1a0a0c1a0b0d1c0e0e241412311a153e1f184a211b51211a521e194c1a16430b1d2c0d26370e2c400f2c420e273e0d1f340c15280a0f200a0d1b0b0c1b0d0c1c110d1e150e211a10261e122d1f13321d143519123314112e100f270e1e3d10274e132e5b143160132e5d1228520f1f420d16310e1024130e211d0f2529112b3313303915353c16373b15373515342b122f1f1028140e20142c5c1738741941861b458e1a438a183b7b15306615244d1c1a3a2a15323c16374f19415d1c49661e4e6a1f50661e4f5d1c494f19413d153729122b1739771c48962054af225bbb2157b51e4d9f1c3f83213067302452451d485d1d4b73215586246094276899286b9427688725607421565d1c4944173a193f831f4fa5245ec32667d32563cb2255b12146922b3675402a5f5923557422588f2765a82c74bc307fc43283bc307fa82c748f2665742256571b45183c7c1d4b9b2157b6245ec2225bbc2050a52142892e347045295e5f23567b245c99286bb52f7bcd3489d7368fcd3489b62f7b99296c7c225a5d1c49',
      dusk: '150b2a150b2a150b2a150b2a150b2a150b2a150b2a160b2b180c2d1c0e3321103c2713442c154b301852341957361a5b381b5d381b5c361a59321855180c2c180c2c180c2c180c2c180c2c180c2c180c2d1a0c2f1d0e3423113d2914472f174f351a583a1c603f1f6743206d45217044216e411f6a3d1e641b0d301b0d301b0d301b0d301b0d301b0d301b0d311d0e33220f3a2813432e164d3519563b1c5f411f694622724c24794f257e4e257c4a237644216e1e0e331f0f331f0f331f0f331f0f331e0e331e0e33200f3625113d2a1446311750371a593e1d6243206b4923744e257b51278050267f4b24784721702a11382e12392f13392e13392c123928113724103723103926113e2b144631174e3619573c1c5f411f6745216e4823734b23764a2375472271431f6a4619414e1b43511c44501c444b1a4342184036153d2d133c29123d2a13432e154a331851381a583b1c5e3e1e63411f66421f68411f673f1e653d1d616b234c76264f7b28507a285072264e64224b531d464118423315402c13402c14442f154a32174f351953381a57391b593a1b5b391b5a381a593619568b2c559b3159a3335ba1335a942f57822a536d244e571e484119443115402c13402d14422e154530164932174b33174d33174d33174d32174c31164a9e3259b2385ebf3b62bb3a61aa355c932f577c295164224b4c1c453817402f153e2e153f2f153f2f15402f15413015423015433015432f15422e14419d3258b0385dbb3b60b7395fa9365a953155812c506d2749592343481f3f3f1d3d3c1b3d391a3d36183d33173d32163e31153e31153e31153e30153d892d529830569f33579f345799345390354f8735497c354471334068323d63303c5f2e3c582b3c50263c46203c3d1b3c36173c34173c34173c33173c6d254978294c7f2c4c87314b8c3849903d4691424290453e90483c904a3b8f493b8a473b81413b753a3b66323b56283b46203b3b1a3b37183b36183b',
      ocean: '043845054855065363075c6b075e6e075a6a0651610545540539470b39441a4c532c6b6d3e8c894da8a253b4ac4da9a23f8d8a2d6c6e1b49500b2a36064c5a075e6e086e7e09798a097c8e097788086a7b075a6a074b5a0c46521a515a2c6b6e3d8b884ba7a052b3ab4ca7a13d8c8a2c6b6e1a49510b2a37075767086c7d0a7f920b8fa20b94a70b8c9e0a7b8c0867780754640947551247521f555b2d6c6e367f7e3a868537807f2d6d6f1f535a123843062231075969086e7f0a82940c93a50c99ab0b8fa20a7d8f09697b0755650641510835430e364116414b1d4d561f525a1d4e5816434f0f3442072535031c2e0651600863740974850a80920b84960a7e90097082085f71064c5d05394a0429390522320725370b2b400c2e440b2d4609294306243e052039041f34054050065060075d6d086576096879086374085a6b074d5d053d4e042e3f04233704203705223f07254808284e08295208295307285107264d062446032c3c04384805425206485806495a064758064050053647042c3d04243805223c062446072851092c5b0a2e640b306a0b316b0b3069092e62082b5a031e2d032333032939042d3d042e3f042c3d042839032435032033042038062444082952092d600c326d0d35780e38800e39820d387e0c34750a316a031a29031b2b031d2d031e2e031f2f031e2f031e2e031d2e031d3105213b07264a092b590b30680d35770f3984103d8f103f93103c8c0e38800c3473031b2a031b2b031b2c031c2c031c2d031c2d031d2e031d2e031e3205213c06264b082b590a30680d35760e39830f3d8d103e900f3c8b0d38800b3472031b2b031c2d031c2d031c2e031d2e031d2e031d2f031e2f031e32042039052445072952092e600b316c0c35760d377d0d387e0d377b0c35740a3169031c2d031d2e031d2e031d2f031d2f031e30031e30031e31031f3103203504223d052648072952082c5c092f630a31680a31690a3067092f62082c5b',
      observatory: '04060b04060b04060b04060b04060b04060b04060b04060b04060b04070d050910070d1709111c09121f09111d080e19060b1305070e04060c04060b04060b04060b04060b04060b04060b04060b04060b04060b04060b05070d060a12080e190a13200b15230a142208111c060c1505080f04070c04060b04060b04060b04060b04060b04060b04060b04060b04060b04060b05070d060a12080f190a121f0b15230a142108101c060c1505080f04070c04060b04060b04060c04060c04060b04060b04060b04060b04060b04060b04070d050911070d1509101a09121e09111d080e18060a1204070e04060c04060b05070d06070e06070e05070d05060c04060b04060b04060b04060b04060c04080e060a11070c15070d17070d16060a1205090f04070c04060b04060b06081008091108091207080f05070d05060c04060b04060b04060b04060b04070c04080e05091005091105091005080e04070d04060b04060b04060b080a140a0b150a0a1508091206080f05070c04060b04060b04060b04060b04070c05070d05080e05080e05080e05070d04060c04060b04060b04060b0a0a160c0c180b0b18090a1407080f05070d05060c04060b04060b04060b04070d05080e06080f06090f05080f05070d04070c04060b04060b04060b0a0a150b0b180b0b17090a1407080f05060d04060c04060b04060b04070c05080e060910070a12070a12060a1105080f05070d04060b04060b04060b08091309091408091407081106070e05060c04060b04060b04060b05070d06080f070a12070b15080c15070b1306091005070d04070b04060b04060b06070f06080f06080f06070e05060d04060b04060b04060b04060b05070d060910070b13080c16080d17070c1506091205080e04070c04060b04060b05060c05070c05070c05060c04060b04060b04060b04060b04060b04070d06090f070a12070b14070c15070b1406091105070e04070c04060b04060b',
    } };

  // ── Adaptive ink ──
  // Text colour follows what is actually behind each glass surface: sample the
  // background (custom image pixels, or the measured scene grid), apply the
  // dim, composite the glass fill, then pick light or dark ink by worst-case
  // WCAG contrast. If neither reaches 4.5:1, add the minimum scrim (a darker
  // or lighter layer inside the glass) that does. Results are written as CSS
  // variables on each panel (inherited by bubbles, chips and inputs) and on
  // <html> for floating surfaces (settings, menus, toasts).
  const PANELS = ['.sidebar', '.chat', '.ops'];
  const INK_VARS = ['--text', '--text-muted', '--ink-shadow', '--ink-scrim', '--ink-orb', '--success', '--warning', '--error', '--ink-chip', '--ink-chip-hover', '--ink-bubble'];
  const LIGHT = [244, 246, 251], DARK = [12, 15, 22];
  const TARGET = 4.5;
  let customBitmap = null;
  let inkTimer = 0;
  let lastInk = {};

  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const v = i / 255; LIN[i] = v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  const lin = (v) => LIN[v < 0 ? 0 : v > 255 ? 255 : Math.round(v)];
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  function parseColor(str) {
    const m = String(str).match(/-?[\d.]+/g);
    return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
  }
  const rgb = (c, a) => (a === undefined ? `rgb(${c.map(Math.round).join(', ')})` : `rgba(${c.map(Math.round).join(', ')}, ${a})`);

  async function setCustomBitmap(blob) {
    if (customBitmap && customBitmap.close) customBitmap.close();
    customBitmap = null;
    if (!blob) return;
    try { customBitmap = await window.createImageBitmap(blob, { resizeWidth: 256, resizeQuality: 'medium' }); } catch (e) { customBitmap = null; }
  }

  // Background as seen by the panels, at 1/16 viewport resolution.
  function sampleBackdrop(theme) {
    const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
    const cw = Math.ceil(vw / 16), ch = Math.ceil(vh / 16);
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    const bg = document.documentElement.dataset.bg;
    g.fillStyle = rgb(theme.bg); g.fillRect(0, 0, cw, ch);
    if (bg === 'custom' && customBitmap) {
      const s = Math.max(cw / customBitmap.width, ch / customBitmap.height);
      const w = customBitmap.width * s, h = customBitmap.height * s;
      g.drawImage(customBitmap, (cw - w) / 2, (ch - h) / 2, w, h);
    } else if (SCENE_GRIDS.cells[bg]) {
      const hex = SCENE_GRIDS.cells[bg], gw = SCENE_GRIDS.w, gh = SCENE_GRIDS.h;
      const small = document.createElement('canvas'); small.width = gw; small.height = gh;
      const sg = small.getContext('2d'); const img = sg.createImageData(gw, gh);
      for (let i = 0, j = 0; i < hex.length; i += 6, j += 4) {
        img.data[j] = parseInt(hex.slice(i, i + 2), 16); img.data[j + 1] = parseInt(hex.slice(i + 2, i + 4), 16);
        img.data[j + 2] = parseInt(hex.slice(i + 4, i + 6), 16); img.data[j + 3] = 255;
      }
      sg.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true; g.drawImage(small, 0, 0, cw, ch);
    }
    if (current.bgDim > 0) { g.fillStyle = `rgba(0,0,0,${current.bgDim / 100})`; g.fillRect(0, 0, cw, ch); }
    // Run the samples through the same filter the glass applies (blur scaled to
    // this 1/16 canvas), so saturation boosts are judged as the eye sees them.
    const cs = getComputedStyle(document.documentElement);
    const sat = parseFloat(cs.getPropertyValue('--glass-sat')) || 1;
    const bright = parseFloat(cs.getPropertyValue('--glass-bright')) || 1;
    const f = document.createElement('canvas'); f.width = cw; f.height = ch;
    const fg = f.getContext('2d', { willReadFrequently: true });
    fg.filter = `blur(${Math.max(0, current.glassBlur / 16)}px) saturate(${sat}) brightness(${bright})`;
    fg.drawImage(c, 0, 0);
    return { g: fg, cw, ch, vw, vh };
  }

  function pixelsIn(sm, rect) {
    const x0 = Math.max(0, Math.floor(rect.left / 16)), y0 = Math.max(0, Math.floor(rect.top / 16));
    const x1 = Math.min(sm.cw, Math.ceil(rect.right / 16)), y1 = Math.min(sm.ch, Math.ceil(rect.bottom / 16));
    if (x1 <= x0 || y1 <= y0) return [];
    const d = sm.g.getImageData(x0, y0, x1 - x0, y1 - y0).data; const out = [];
    // At most ~300 samples per surface keeps a full refresh in a few ms.
    const step = Math.max(1, Math.floor(d.length / 4 / 300)) * 4;
    for (let i = 0; i < d.length; i += step) out.push([d[i], d[i + 1], d[i + 2]]);
    return out;
  }

  // Worst-case (10th percentile) contrast of `ink` over the composited pixels.
  function score(pixels, ink) {
    const li = lum(ink);
    const cs = new Float32Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) { const lp = lum(pixels[i]); cs[i] = (Math.max(lp, li) + 0.05) / (Math.min(lp, li) + 0.05); }
    cs.sort();
    return cs[Math.floor(cs.length * 0.03)] || 21;
  }

  // Chips and bubbles add their own fill over the glass; text must read on both.
  const CHIP = { light: [[255, 255, 255], 0.07], dark: [[255, 255, 255], 0.34] };
  const BUBBLE = { light: [[8, 10, 16], 0.26], dark: [[255, 255, 255], 0.5] };
  function layers(under, ink) {
    const k = ink === LIGHT ? 'light' : 'dark';
    return under.concat(under.map((p) => mix(p, CHIP[k][0], CHIP[k][1])), under.map((p) => mix(p, BUBBLE[k][0], BUBBLE[k][1])));
  }
  function decide(pixels, fill, fillA) {
    if (!pixels.length) return null;
    const under = pixels.map((p) => mix(p, fill, fillA));
    let best = null;
    for (const ink of [LIGHT, DARK]) {
      const scrimC = ink === LIGHT ? [0, 0, 0] : [255, 255, 255];
      const base = layers(under, ink);
      let s = 0, sc = score(base, ink);
      while (sc < TARGET && s < 0.9) { s = Math.round((s + 0.05) * 100) / 100; sc = score(base.map((p) => mix(p, scrimC, s)), ink); }
      if (!best || s < best.scrim || (s === best.scrim && sc > best.score)) best = { ink, scrim: s, scrimC, score: sc };
    }
    const seen = layers(under, best.ink).map((p) => mix(p, best.scrimC, best.scrim));
    const avg = seen.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / seen.length);
    // Muted text: as faint as it can be while every sample still reads at 4.5:1.
    let mutedA = 0.7;
    while (mutedA < 1 && score(seen, mix(avg, best.ink, mutedA)) < TARGET) mutedA += 0.05;
    return { ...best, avg, seen, mutedA: Math.min(1, mutedA) };
  }

  function inkVars(dec, theme) {
    const light = dec.ink === LIGHT;
    // Semantic colours keep their hue but are pulled toward the ink until they
    // read at 4.5:1 against the worst sample (green "Ready" on a green scene).
    const toward = light ? [255, 255, 255] : [0, 0, 0];
    const fix = (c) => { let t = 0, out = c; while (score(dec.seen, out) < TARGET && t < 1) { t = Math.min(1, t + 0.1); out = mix(c, toward, t); } return rgb(out); };
    return {
      '--text': rgb(dec.ink),
      '--text-muted': rgb(mix(dec.avg, dec.ink, dec.mutedA)),
      '--ink-shadow': light ? '0 1px 2px rgba(0,0,0,.45), 0 0 12px rgba(0,0,0,.18)' : '0 1px 1px rgba(255,255,255,.35)',
      '--ink-scrim': dec.scrim ? rgb(dec.scrimC, dec.scrim) : 'transparent',
      '--ink-orb': light ? '#e8eef8' : '#1d2433',
      '--ink-chip': light ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.34)',
      '--ink-chip-hover': light ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.5)',
      '--ink-bubble': light ? 'rgba(8,10,16,.26)' : 'rgba(255,255,255,.5)',
      '--success': fix(theme.success), '--warning': fix(theme.warning), '--error': fix(theme.error),
    };
  }

  function writeVars(el, vars) { for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v); }
  function clearVars(el) { for (const k of INK_VARS) el.style.removeProperty(k); }

  function refreshInk() {
    const root = document.documentElement;
    clearVars(root);
    const cs = getComputedStyle(root);
    const num = (n, f) => { const v = parseFloat(cs.getPropertyValue(n)); return Number.isFinite(v) ? v : f; };
    const theme = {
      bg: parseColor(cs.getPropertyValue('--bg')) || [4, 6, 11],
      success: parseColor(cs.getPropertyValue('--success')) || [16, 185, 129],
      warning: parseColor(cs.getPropertyValue('--warning')) || [245, 158, 11],
      error: parseColor(cs.getPropertyValue('--error')) || [239, 68, 68],
    };
    const fill = parseColor(cs.getPropertyValue('--glass-rgb')) || [16, 18, 24];
    const a = Math.min(1, num('--glass-tint', 0.3) * num('--glass-k', 1));
    const sm = sampleBackdrop(theme);
    const report = {};
    for (const sel of PANELS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const dec = r.width && r.height ? decide(pixelsIn(sm, r), fill, a) : null;
      if (!dec) { clearVars(el); delete el.dataset.ink; continue; }
      writeVars(el, inkVars(dec, theme));
      el.dataset.ink = dec.ink === LIGHT ? 'light' : 'dark';
      report[sel] = { ink: dec.ink === LIGHT ? 'light' : 'dark', scrim: dec.scrim, contrast: Math.round(dec.score * 10) / 10 };
    }
    // Floating surfaces: centre of the window, behind the overlay veil + denser glass.
    const veiled = pixelsIn(sm, { left: sm.vw * 0.2, top: sm.vh * 0.1, right: sm.vw * 0.8, bottom: sm.vh * 0.9 }).map((p) => mix(p, [3, 5, 10], 0.35));
    const dec = decide(veiled, fill, Math.min(0.9, a + 0.38));
    if (dec) { writeVars(root, inkVars(dec, theme)); report.overlay = { ink: dec.ink === LIGHT ? 'light' : 'dark', scrim: dec.scrim, contrast: Math.round(dec.score * 10) / 10 }; }
    root.dataset.ink = report['.chat'] ? report['.chat'].ink : (dec && dec.ink === LIGHT ? 'light' : 'dark');
    const orbChanged = (lastInk['.ops'] || {}).ink !== (report['.ops'] || {}).ink;
    lastInk = report;
    if (orbChanged && window.AriaOrb && window.AriaOrb.refreshAccent) window.AriaOrb.refreshAccent();
    return report;
  }
  function scheduleInk() {
    cancelAnimationFrame(inkTimer);
    inkTimer = requestAnimationFrame(() => { try { refreshInk(); } catch (e) { console.warn('[appearance] ink failed', e); } });
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(scheduleInk, 150); });

  function clamp(n, lo, hi, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  }

  function normalize(s) {
    const o = s || {};
    return {
      background: BACKGROUNDS.some((b) => b.id === o.background) ? o.background : DEFAULTS.background,
      glassStyle: STYLES.includes(o.glassStyle) ? o.glassStyle : DEFAULTS.glassStyle,
      glassBlur: clamp(o.glassBlur, 0, 60, DEFAULTS.glassBlur),
      glassOpacity: clamp(o.glassOpacity, 0, 100, DEFAULTS.glassOpacity),
      bgDim: clamp(o.bgDim, 0, 80, DEFAULTS.bgDim),
    };
  }

  // ── IndexedDB (one object store, one key) ──
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbOp(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const loadCustomBlob = () => dbOp('readonly', (s) => s.get(KEY)).catch(() => null);

  // ── Wallpaper cross-fade ──
  // The live .bg-layer switches scene at once; a clone of the outgoing scene is
  // laid on top of it and faded out, so the change reads as a dissolve. The
  // clone drops every id (no duplicate #bg-custom) and at most two ever exist,
  // so rapid clicking can't pile up layers the backdrop blur has to sample.
  const FADE_MS = 800;
  let shownBg = null;
  function crossfade() {
    const layer = document.querySelector('.bg-layer:not(.bg-leaving)');
    if (!layer || !layer.parentNode) return;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || document.hidden) return;
    const old = document.querySelectorAll('.bg-layer.bg-leaving');
    for (let i = 0; i < old.length - 1; i++) old[i].remove();
    const ghost = layer.cloneNode(true);
    ghost.classList.add('bg-leaving');
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    layer.parentNode.insertBefore(ghost, layer.nextSibling);
    let done = false;
    const drop = () => { if (!done) { done = true; ghost.remove(); } };
    ghost.addEventListener('transitionend', (e) => { if (e.target === ghost && e.propertyName === 'opacity') drop(); });
    setTimeout(drop, FADE_MS + 250); // hidden/throttled windows may never fire transitionend
    void ghost.offsetWidth; // start from opacity 1
    ghost.style.opacity = '0';
  }
  function showBg(bg) {
    const layer = document.querySelector('.bg-layer:not(.bg-leaving)');
    if (shownBg !== null && shownBg !== bg) crossfade();
    shownBg = bg;
    if (layer) layer.dataset.bg = bg;
    document.documentElement.dataset.bg = bg;
  }

  function setCustomUrl(blob) {
    // Replacing the image on screen dissolves too, not just scene switches.
    if (shownBg === 'custom' && customUrl) crossfade();
    if (customUrl) URL.revokeObjectURL(customUrl);
    customUrl = blob ? URL.createObjectURL(blob) : null;
    const el = document.getElementById('bg-custom');
    if (el) el.style.backgroundImage = customUrl ? `url("${customUrl}")` : '';
    document.documentElement.dataset.hasCustomBg = customUrl ? 'true' : 'false';
  }

  /** Validate and store an image File/Blob as the custom background. */
  async function setCustomImage(file) {
    if (!file) throw new Error('No file selected.');
    if (!ACCEPTED.test(file.type || '')) throw new Error('Use a PNG, JPEG, WebP, AVIF, GIF or BMP image.');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('That image is over 25 MB. Pick a smaller one.');
    // Decode before storing so a corrupt file never becomes the saved background.
    const url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = () => reject(new Error('That file could not be read as an image.'));
        img.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    await dbOp('readwrite', (s) => s.put(blob, KEY));
    setCustomUrl(blob);
    await setCustomBitmap(blob);
    return true;
  }

  async function clearCustomImage() {
    await dbOp('readwrite', (s) => s.delete(KEY)).catch(() => {});
    setCustomUrl(null);
    await setCustomBitmap(null);
  }

  const hasCustomImage = () => !!customUrl;

  /** Apply a (partial) appearance state. Returns the normalized state. */
  function apply(state) {
    current = normalize({ ...current, ...(state || {}) });
    const root = document.documentElement;
    // A missing custom image falls back to the default scene instead of black.
    const bg = current.background === 'custom' && !customUrl ? DEFAULTS.background : current.background;
    showBg(bg);
    root.dataset.glass = current.glassStyle;
    root.style.setProperty('--glass-blur', `${current.glassBlur}px`);
    root.style.setProperty('--glass-tint', String(current.glassOpacity / 100));
    root.style.setProperty('--bg-dim', String(current.bgDim / 100));
    scheduleInk();
    return { ...current };
  }

  async function init(state) {
    const blob = await loadCustomBlob();
    if (blob) { setCustomUrl(blob); await setCustomBitmap(blob); }
    return apply(state);
  }

  window.AriaAppearance = {
    BACKGROUNDS, STYLES, DEFAULTS, MAX_IMAGE_BYTES,
    normalize, apply, init, setCustomImage, clearCustomImage, hasCustomImage, refreshInk, scheduleInk,
    get state() { return { ...current }; },
  };
})();
