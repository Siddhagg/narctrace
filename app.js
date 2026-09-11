'use strict';

/* ============================================================
   NarcTrace — client-only prototype
   Everything runs in the browser: camera, geolocation, colour
   analysis and history storage. No backend, no uploads.
   ============================================================ */

const TARGET_PHOTOS = 6;
const MIN_PHOTOS_TO_FINISH_EARLY = 4;

const COLOR_PALETTE = [
  ['Red',    [211, 47, 47]],
  ['Orange', [245, 124, 0]],
  ['Yellow', [251, 192, 45]],
  ['Green',  [56, 142, 60]],
  ['Blue',   [25, 90, 190]],
  ['Purple', [123, 31, 162]],
  ['Pink',   [216, 27, 96]],
  ['Brown',  [109, 76, 65]],
  ['Black',  [30, 30, 30]],
  ['White',  [235, 235, 230]],
  ['Gray',   [130, 130, 130]],
];

const el = (id) => document.getElementById(id);

const state = {
  officer: null,          // { name, badge }
  permissions: { camera: false, location: false },
  cameraStream: null,
  liveSampleTimer: null,
  liveColorBuffer: [],
  currentTest: null,      // { id, officer, badge, startedAt, lat, lon, city, state, address, photos: [] }
};

/* --------------------- Screen navigation --------------------- */

const SCREENS = ['permissions', 'login', 'home', 'test', 'report', 'history', 'detail'];

function showScreen(name) {
  for (const s of SCREENS) {
    const node = el(`screen-${s}`);
    if (node) node.hidden = s !== name;
  }
  const topnav = el('topnav');
  if (state.officer) {
    topnav.hidden = false;
    el('navTest').classList.toggle('active', name === 'test' || name === 'report');
    el('navHistory').classList.toggle('active', name === 'history' || name === 'detail');
  } else {
    topnav.hidden = true;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* --------------------- Utility helpers --------------------- */

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function nearestColorName(r, g, b) {
  let best = null;
  let bestDist = Infinity;
  for (const [name, [pr, pg, pb]] of COLOR_PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

function generateTestId() {
  let counter = parseInt(localStorage.getItem('narctrace_counter') || '120', 10);
  counter += 1;
  localStorage.setItem('narctrace_counter', String(counter));
  return `FT-${String(counter).padStart(5, '0')}`;
}

function formatTimestamp(date) {
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function getCurrentPositionAsync(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('reverse geocode failed');
    const data = await res.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || '';
    const stateName = addr.state || addr.state_district || '';
    const address = data.display_name || '';
    return { city, state: stateName, address };
  } catch (err) {
    return { city: '', state: '', address: 'Unable to resolve address (offline or API unavailable)' };
  }
}

function setMapFrame(lat, lon) {
  const d = 0.008;
  const bbox = `${lon - d}%2C${lat - d}%2C${lon + d}%2C${lat + d}`;
  el('mapFrame').src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
  el('mapWrap').hidden = false;
}

/* --------------------- Permissions screen --------------------- */

el('btnEnable').addEventListener('click', requestPermissions);

async function requestPermissions() {
  const btn = el('btnEnable');
  btn.disabled = true;
  el('permError').hidden = true;

  const camItem = el('permCameraItem');
  const locItem = el('permLocationItem');
  const camStatus = el('permCameraStatus');
  const locStatus = el('permLocationStatus');

  camStatus.textContent = 'Requesting…';
  locStatus.textContent = 'Requesting…';

  // Camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    stream.getTracks().forEach((t) => t.stop());
    state.permissions.camera = true;
    camItem.classList.add('granted');
    camItem.classList.remove('denied');
    camStatus.textContent = 'Granted';
  } catch (err) {
    state.permissions.camera = false;
    camItem.classList.add('denied');
    camStatus.textContent = 'Denied';
  }

  // Location
  try {
    await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 10000 });
    state.permissions.location = true;
    locItem.classList.add('granted');
    locItem.classList.remove('denied');
    locStatus.textContent = 'Granted';
  } catch (err) {
    state.permissions.location = false;
    locItem.classList.add('denied');
    locStatus.textContent = 'Denied';
  }

  btn.disabled = false;

  if (state.permissions.camera && state.permissions.location) {
    const savedOfficer = sessionStorage.getItem('narctrace_officer');
    if (savedOfficer) {
      state.officer = JSON.parse(savedOfficer);
      el('homeOfficerName').textContent = state.officer.name;
      showScreen('home');
    } else {
      showScreen('login');
    }
  } else {
    const missing = [];
    if (!state.permissions.camera) missing.push('camera');
    if (!state.permissions.location) missing.push('location');
    const errNode = el('permError');
    errNode.hidden = false;
    errNode.textContent = `NarcTrace needs ${missing.join(' and ')} access to continue. Please allow the permission in your browser (check the site settings/padlock icon) and try again.`;
  }
}

/* --------------------- Officer login --------------------- */

el('btnLogin').addEventListener('click', () => {
  const name = el('officerName').value.trim();
  const badge = el('officerBadge').value.trim();
  const errNode = el('loginError');
  if (!name || !badge) {
    errNode.hidden = false;
    errNode.textContent = 'Please enter both your name and badge/ID number.';
    return;
  }
  errNode.hidden = true;
  state.officer = { name, badge };
  sessionStorage.setItem('narctrace_officer', JSON.stringify(state.officer));
  el('homeOfficerName').textContent = name;
  el('officerChip').hidden = false;
  el('officerChip').textContent = `${name} · ${badge}`;
  showScreen('home');
});

/* --------------------- Home --------------------- */

el('btnStartTest').addEventListener('click', startNewTest);
el('btnViewHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
el('navTest').addEventListener('click', () => {
  if (state.currentTest && !state.currentTest.finishedAt) showScreen('test');
  else startNewTest();
});
el('navHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
el('btnLogout').addEventListener('click', () => {
  sessionStorage.removeItem('narctrace_officer');
  state.officer = null;
  el('officerChip').hidden = true;
  el('officerName').value = '';
  el('officerBadge').value = '';
  showScreen('login');
});

/* --------------------- Active test --------------------- */

async function startNewTest() {
  stopCamera();

  const test = {
    id: generateTestId(),
    officer: state.officer.name,
    badge: state.officer.badge,
    startedAt: new Date().toISOString(),
    lat: null,
    lon: null,
    city: '',
    state: '',
    address: '',
    photos: [],
  };
  state.currentTest = test;
  state.liveColorBuffer = [];

  el('activeTestId').textContent = test.id;
  el('metaOfficer').textContent = `${test.officer} (${test.badge})`;
  el('metaTime').textContent = formatTimestamp(new Date(test.startedAt));
  el('metaGpsStatus').textContent = 'Locating…';
  el('metaCoords').textContent = '—';
  el('metaCityState').textContent = '—';
  el('metaAddress').textContent = '—';
  el('mapWrap').hidden = true;
  el('thumbGrid').innerHTML = '';
  el('btnFinishEarly').hidden = true;
  updateProgress();

  showScreen('test');
  locateForTest(test);
  startCamera();
}

async function locateForTest(test) {
  try {
    const pos = await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 15000 });
    test.lat = pos.coords.latitude;
    test.lon = pos.coords.longitude;
    el('metaGpsStatus').textContent = `Locked (±${Math.round(pos.coords.accuracy)}m)`;
    el('metaCoords').textContent = `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}`;
    setMapFrame(test.lat, test.lon);

    const geo = await reverseGeocode(test.lat, test.lon);
    test.city = geo.city;
    test.state = geo.state;
    test.address = geo.address;
    el('metaCityState').textContent = [geo.city, geo.state].filter(Boolean).join(', ') || 'Unknown';
    el('metaAddress').textContent = geo.address || '—';
  } catch (err) {
    el('metaGpsStatus').textContent = 'Unavailable';
    el('metaCityState').textContent = 'Unknown';
    el('metaAddress').textContent = 'Location could not be determined';
  }
}

async function startCamera() {
  const video = el('video');
  const overlay = el('overlayCanvas');
  const hidden = el('hiddenCanvas');
  const statusEl = el('cameraStatus');

  try {
    statusEl.textContent = 'Starting camera…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
    });
    state.cameraStream = stream;
    video.srcObject = stream;
    await video.play();

    hidden.width = video.videoWidth || 1280;
    hidden.height = video.videoHeight || 960;
    resizeOverlay();

    statusEl.textContent = 'Point the reaction/object at the centre box';

    state.liveSampleTimer = setInterval(sampleLiveColor, 250);
  } catch (err) {
    statusEl.textContent = 'Camera access failed — check permissions and reload';
  }
}

function stopCamera() {
  if (state.liveSampleTimer) {
    clearInterval(state.liveSampleTimer);
    state.liveSampleTimer = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
}

window.addEventListener('resize', resizeOverlay);

function resizeOverlay() {
  const box = document.querySelector('.camera-box');
  const overlay = el('overlayCanvas');
  if (!box || !overlay) return;
  overlay.width = box.clientWidth;
  overlay.height = box.clientHeight;
  drawFocusBoxOutline();
}

function focusBoxRect(width, height) {
  const size = Math.floor(Math.min(width, height) * 0.35);
  const x = Math.floor((width - size) / 2);
  const y = Math.floor((height - size) / 2);
  return { x, y, size };
}

function drawFocusBoxOutline() {
  const overlay = el('overlayCanvas');
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const { x, y, size } = focusBoxRect(overlay.width, overlay.height);
  ctx.strokeStyle = '#29d3b0';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x, y, size, size);
  ctx.setLineDash([]);
  const corner = 14;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#eaf0fb';
  [[x, y, 1, 1], [x + size, y, -1, 1], [x, y + size, 1, -1], [x + size, y + size, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + corner * dy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + corner * dx, cy);
    ctx.stroke();
  });
}

function readFocusColor(canvas) {
  const ctx = canvas.getContext('2d');
  const { x, y, size } = focusBoxRect(canvas.width, canvas.height);
  const data = ctx.getImageData(x, y, size, size).data;
  let r = 0, g = 0, b = 0, n = 0;
  const stride = 4 * 3; // sample every 3rd pixel for performance
  for (let i = 0; i < data.length; i += stride) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  r = Math.round(r / n);
  g = Math.round(g / n);
  b = Math.round(b / n);
  return { r, g, b };
}

function sampleLiveColor() {
  const video = el('video');
  const hidden = el('hiddenCanvas');
  if (!video.videoWidth) return;
  const ctx = hidden.getContext('2d');
  ctx.drawImage(video, 0, 0, hidden.width, hidden.height);
  drawFocusBoxOutline();

  const { r, g, b } = readFocusColor(hidden);
  state.liveColorBuffer.push({ r, g, b });
  if (state.liveColorBuffer.length > 4) state.liveColorBuffer.shift();

  const avg = state.liveColorBuffer.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
  const n = state.liveColorBuffer.length;
  const sr = Math.round(avg.r / n), sg = Math.round(avg.g / n), sb = Math.round(avg.b / n);
  const hex = rgbToHex(sr, sg, sb);
  const name = nearestColorName(sr, sg, sb);

  el('liveSwatch').style.background = hex;
  el('liveColorName').textContent = name;
  el('liveColorHex').textContent = `${hex} · rgb(${sr}, ${sg}, ${sb})`;
}

function updateProgress() {
  const count = state.currentTest ? state.currentTest.photos.length : 0;
  el('progressFill').style.width = `${Math.min(100, (count / TARGET_PHOTOS) * 100)}%`;
  el('progressText').textContent = `${count} / ${TARGET_PHOTOS} photos`;
  el('btnFinishEarly').hidden = count < MIN_PHOTOS_TO_FINISH_EARLY || count >= TARGET_PHOTOS;
}

el('btnCapture').addEventListener('click', capturePhoto);
el('btnFinishEarly').addEventListener('click', finishTest);

function capturePhoto() {
  const video = el('video');
  const hidden = el('hiddenCanvas');
  if (!video.videoWidth) return;

  const ctx = hidden.getContext('2d');
  ctx.drawImage(video, 0, 0, hidden.width, hidden.height);
  const { r, g, b } = readFocusColor(hidden);
  const hex = rgbToHex(r, g, b);
  const name = nearestColorName(r, g, b);

  // Downscale for storage-efficient thumbnail/report image
  const small = document.createElement('canvas');
  const scale = 480 / hidden.width;
  small.width = 480;
  small.height = Math.round(hidden.height * scale);
  small.getContext('2d').drawImage(hidden, 0, 0, small.width, small.height);
  const dataUrl = small.toDataURL('image/jpeg', 0.6);

  const photo = { dataUrl, hex, rgb: { r, g, b }, name, capturedAt: new Date().toISOString() };
  state.currentTest.photos.push(photo);

  const thumb = document.createElement('div');
  thumb.className = 'thumb-item';
  thumb.innerHTML = `
    <img src="${dataUrl}" alt="Captured photo ${state.currentTest.photos.length}" />
    <span class="thumb-badge">#${state.currentTest.photos.length}</span>
    <span class="thumb-swatch" style="background:${hex}" title="${name} (${hex})"></span>
  `;
  el('thumbGrid').appendChild(thumb);

  updateProgress();

  if (state.currentTest.photos.length >= TARGET_PHOTOS) {
    finishTest();
  }
}

function finishTest() {
  stopCamera();
  state.currentTest.finishedAt = new Date().toISOString();
  renderReport(state.currentTest);
  showScreen('report');
}

/* --------------------- Report --------------------- */

function modeColorName(photos) {
  const counts = {};
  for (const p of photos) counts[p.name] = (counts[p.name] || 0) + 1;
  let best = null, bestCount = -1;
  for (const [name, c] of Object.entries(counts)) {
    if (c > bestCount) { best = name; bestCount = c; }
  }
  return best;
}

function renderReport(test) {
  el('reportTestId').textContent = test.id;
  el('reportOfficer').textContent = `${test.officer} (${test.badge})`;
  el('reportTime').textContent = formatTimestamp(new Date(test.startedAt));
  el('reportCoords').textContent = test.lat != null ? `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}` : 'Unavailable';
  el('reportCityState').textContent = [test.city, test.state].filter(Boolean).join(', ') || 'Unknown';
  el('reportAddress').textContent = test.address || '—';

  const dominant = test.photos.length ? modeColorName(test.photos) : '—';
  const dominantPhoto = test.photos.find((p) => p.name === dominant);
  el('reportDominantColor').innerHTML = dominantPhoto
    ? `<span class="swatch" style="display:inline-block;width:16px;height:16px;vertical-align:middle;margin-right:6px;border-radius:4px;background:${dominantPhoto.hex}"></span>${dominant} (${dominantPhoto.hex})`
    : '—';

  const grid = el('reportPhotoGrid');
  grid.innerHTML = '';
  test.photos.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'report-photo';
    card.innerHTML = `
      <img src="${p.dataUrl}" alt="Frame ${i + 1}" />
      <div class="report-photo-info">
        <span class="swatch" style="background:${p.hex}"></span>
        <span>${p.name} · ${p.hex}</span>
      </div>
    `;
    grid.appendChild(card);
  });

  el('btnSaveReport').disabled = false;
  el('btnSaveReport').textContent = '💾 Save to Test History';
}

el('btnSaveReport').addEventListener('click', () => {
  saveTestToHistory(state.currentTest);
  el('btnSaveReport').disabled = true;
  el('btnSaveReport').textContent = '✅ Saved';
});
el('btnNewTestFromReport').addEventListener('click', startNewTest);
el('btnHistoryFromReport').addEventListener('click', () => { renderHistory(); showScreen('history'); });

/* --------------------- History (localStorage) --------------------- */

const HISTORY_KEY = 'narctrace_tests';

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveTestToHistory(test) {
  let history = loadHistory();
  history.unshift(test);
  while (history.length > 0) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      return;
    } catch (e) {
      // Storage quota exceeded — drop the oldest record and retry.
      history.pop();
    }
  }
}

function renderHistory() {
  const history = loadHistory();
  const list = el('historyList');
  const empty = el('historyEmpty');
  list.innerHTML = '';

  if (history.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  history.forEach((test) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const thumb = test.photos[0] ? test.photos[0].dataUrl : '';
    const dominant = test.photos.length ? modeColorName(test.photos) : null;
    const dominantPhoto = dominant ? test.photos.find((p) => p.name === dominant) : null;
    row.innerHTML = `
      ${thumb ? `<img src="${thumb}" alt="" />` : ''}
      <span class="swatch" style="background:${dominantPhoto ? dominantPhoto.hex : '#333'}"></span>
      <div class="history-row-info">
        <div class="hrow-top"><span class="testid">${test.id}</span><strong>${test.officer}</strong></div>
        <span class="hrow-sub">${formatTimestamp(new Date(test.startedAt))} · ${[test.city, test.state].filter(Boolean).join(', ') || 'Unknown location'}</span>
      </div>
    `;
    row.addEventListener('click', () => showHistoryDetail(test));
    list.appendChild(row);
  });
}

function showHistoryDetail(test) {
  const card = el('detailCard');
  const dominant = test.photos.length ? modeColorName(test.photos) : '—';
  const dominantPhoto = test.photos.find((p) => p.name === dominant);
  card.innerHTML = `
    <div class="report-header">
      <h1>Test Report</h1>
      <span class="testid">${test.id}</span>
    </div>
    <div class="report-grid">
      <div class="report-field"><span>Officer</span><strong>${test.officer} (${test.badge})</strong></div>
      <div class="report-field"><span>Timestamp</span><strong>${formatTimestamp(new Date(test.startedAt))}</strong></div>
      <div class="report-field"><span>Coordinates</span><strong>${test.lat != null ? `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}` : 'Unavailable'}</strong></div>
      <div class="report-field"><span>City / State</span><strong>${[test.city, test.state].filter(Boolean).join(', ') || 'Unknown'}</strong></div>
      <div class="report-field wide"><span>Approx. address</span><strong>${test.address || '—'}</strong></div>
      <div class="report-field"><span>Dominant reaction colour</span><strong>${dominantPhoto ? `${dominant} (${dominantPhoto.hex})` : '—'}</strong></div>
    </div>
    <h3>Captured Frames &amp; Colour Analysis</h3>
    <div class="report-photo-grid">
      ${test.photos.map((p, i) => `
        <div class="report-photo">
          <img src="${p.dataUrl}" alt="Frame ${i + 1}" />
          <div class="report-photo-info">
            <span class="swatch" style="background:${p.hex}"></span>
            <span>${p.name} · ${p.hex}</span>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="disclaimer">
      ⚠️ Colour readings assist documentation only. Compare against your test kit's reference chart to interpret the reaction. NarcTrace does not identify substances and is not a replacement for confirmatory laboratory testing.
    </div>
    <div class="report-actions">
      <button class="btn btn-secondary" id="btnBackToHistory">← Back to History</button>
    </div>
  `;
  el('btnBackToHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
  showScreen('detail');
}

el('btnClearHistory').addEventListener('click', () => {
  if (confirm('Delete all saved test records from this device? This cannot be undone.')) {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }
});

el('btnBackHome').addEventListener('click', () => showScreen('home'));

/* --------------------- Init --------------------- */

showScreen('permissions');
