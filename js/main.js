// ============================================
// メタバース空間 - メインスクリプト
// ============================================

// --------------------------------------------
// 初期設定
// --------------------------------------------
let scene, camera, renderer;
let stage, floor;
let avatars = {};
let myAvatar;
let myPenlight;
let penlightOn = false;
let penlightColor = '#ff00ff';

// ユーザー情報（後でPartyKitから取得）
const myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
const myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);

// --------------------------------------------
// Three.js 初期化
// --------------------------------------------
function init() {
  // シーン作成
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  // カメラ設定（スマホ向けに調整）
  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 2, 0);

  // レンダラー設定（スマホ最適化）
  renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'low-power'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  // ライト
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  // ステージライト（スポットライト）
  const stageLight = new THREE.SpotLight(0xff66ff, 1);
  stageLight.position.set(0, 10, 0);
  stageLight.angle = Math.PI / 4;
  stageLight.penumbra = 0.5;
  scene.add(stageLight);

  // 床を作成
  createFloor();

  // ステージを作成
  createStage();

  // 自分のアバターを作成
  myAvatar = createAvatar(myUserId, myUserName, 0x4fc3f7);
  myAvatar.position.set(
    (Math.random() - 0.5) * 8,
    0.5,
    5 + Math.random() * 3
  );
  scene.add(myAvatar);
  avatars[myUserId] = myAvatar;

  // ペンライトを作成
  myPenlight = createPenlight(penlightColor);
  myPenlight.visible = false;
  myAvatar.add(myPenlight);

  // イベントリスナー設定
  setupEventListeners();

  // アニメーションループ開始
  animate();
}

// --------------------------------------------
// 床の作成
// --------------------------------------------
function createFloor() {
  const geometry = new THREE.PlaneGeometry(30, 20);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2d2d44,
    roughness: 0.8
  });
  floor = new THREE.Mesh(geometry, material);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // グリッドを追加
  const grid = new THREE.GridHelper(30, 30, 0x444466, 0x333355);
  grid.position.y = 0.01;
  scene.add(grid);
}

// --------------------------------------------
// ステージの作成
// --------------------------------------------
function createStage() {
  // ステージ本体
  const stageGeometry = new THREE.BoxGeometry(10, 1, 5);
  const stageMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a4a6a,
    roughness: 0.5
  });
  stage = new THREE.Mesh(stageGeometry, stageMaterial);
  stage.position.set(0, 0.5, -5);
  scene.add(stage);

  // ステージ上のライン（装飾）
  const lineGeometry = new THREE.BoxGeometry(10, 0.05, 0.1);
  const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xff66ff });
  const stageLine = new THREE.Mesh(lineGeometry, lineMaterial);
  stageLine.position.set(0, 1.01, -2.4);
  scene.add(stageLine);

  // 後ろのスクリーン（シンプル）
  const screenGeometry = new THREE.PlaneGeometry(12, 5);
  const screenMaterial = new THREE.MeshBasicMaterial({
    color: 0x1a1a3e,
    side: THREE.DoubleSide
  });
  const screen = new THREE.Mesh(screenGeometry, screenMaterial);
  screen.position.set(0, 3.5, -7.4);
  scene.add(screen);
}

// --------------------------------------------
// アバター作成
// --------------------------------------------
function createAvatar(userId, userName, color) {
  const group = new THREE.Group();
  group.userData = { userId: userId, userName: userName };

  // 体（カプセル型を簡易的にシリンダーで）
  const bodyGeometry = new THREE.CylinderGeometry(0.3, 0.35, 1, 8);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: color });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.position.y = 0.5;
  group.add(body);

  // 頭
  const headGeometry = new THREE.SphereGeometry(0.25, 8, 8);
  const headMaterial = new THREE.MeshStandardMaterial({ color: color });
  const head = new THREE.Mesh(headGeometry, headMaterial);
  head.position.y = 1.2;
  group.add(head);

  return group;
}

// --------------------------------------------
// ペンライト作成
// --------------------------------------------
function createPenlight(color) {
  const group = new THREE.Group();

  // 持ち手
  const handleGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8);
  const handleMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const handle = new THREE.Mesh(handleGeometry, handleMaterial);
  group.add(handle);

  // 光る部分
  const lightGeometry = new THREE.CylinderGeometry(0.05, 0.03, 0.3, 8);
  const lightMaterial = new THREE.MeshBasicMaterial({ 
    color: color,
    transparent: true,
    opacity: 0.9
  });
  const light = new THREE.Mesh(lightGeometry, lightMaterial);
  light.position.y = 0.25;
  light.name = 'penlightLight';
  group.add(light);

  // ポイントライト（周囲を照らす）
  const pointLight = new THREE.PointLight(color, 0.5, 3);
  pointLight.position.y = 0.3;
  pointLight.name = 'penlightPointLight';
  group.add(pointLight);

  // 位置調整（アバターの右手位置）
  group.position.set(0.4, 1.3, 0.2);
  group.rotation.z = Math.PI / 6;

  return group;
}

// --------------------------------------------
// ペンライトの色を変更
// --------------------------------------------
function setPenlightColor(color) {
  penlightColor = color;
  
  const light = myPenlight.getObjectByName('penlightLight');
  if (light) {
    light.material.color.set(color);
  }
  
  const pointLight = myPenlight.getObjectByName('penlightPointLight');
  if (pointLight) {
    pointLight.color.set(color);
  }
}

// --------------------------------------------
// ペンライトを振る
// --------------------------------------------
function wavePenlight() {
  if (!penlightOn) return;
  
  const startRotation = myPenlight.rotation.z;
  const swingAmount = 0.3;
  let progress = 0;
  
  function swingAnimation() {
    progress += 0.15;
    if (progress <= Math.PI) {
      myPenlight.rotation.z = startRotation + Math.sin(progress) * swingAmount;
      requestAnimationFrame(swingAnimation);
    } else {
      myPenlight.rotation.z = startRotation;
    }
  }
  swingAnimation();
}

// --------------------------------------------
// ジャンプアニメーション
// --------------------------------------------
function doJump() {
  const startY = myAvatar.position.y;
  let progress = 0;
  
  function jumpAnimation() {
    progress += 0.1;
    if (progress <= Math.PI) {
      myAvatar.position.y = startY + Math.sin(progress) * 1;
      requestAnimationFrame(jumpAnimation);
    } else {
      myAvatar.position.y = startY;
    }
  }
  jumpAnimation();
}

// --------------------------------------------
// オタ芸アニメーション
// --------------------------------------------
function doOtagei(motionId) {
  let progress = 0;
  const duration = Math.PI * 2;
  
  function otageiAnimation() {
    progress += 0.12;
    if (progress <= duration) {
      myAvatar.rotation.z = Math.sin(progress * 3) * 0.2;
      if (myPenlight.visible) {
        myPenlight.rotation.z = Math.PI / 6 + Math.sin(progress * 5) * 0.5;
      }
      requestAnimationFrame(otageiAnimation);
    } else {
      myAvatar.rotation.z = 0;
      myPenlight.rotation.z = Math.PI / 6;
    }
  }
  otageiAnimation();
}

// --------------------------------------------
// 拍手エフェクト
// --------------------------------------------
function doClap() {
  const originalScale = myAvatar.scale.x;
  let progress = 0;
  
  function clapAnimation() {
    progress += 0.2;
    if (progress <= Math.PI) {
      const scale = originalScale + Math.sin(progress) * 0.1;
      myAvatar.scale.set(scale, scale, scale);
      requestAnimationFrame(clapAnimation);
    } else {
      myAvatar.scale.set(originalScale, originalScale, originalScale);
    }
  }
  clapAnimation();
}

// --------------------------------------------
// イベントリスナー設定
// --------------------------------------------
function setupEventListeners() {
  // ウィンドウリサイズ
  window.addEventListener('resize', onWindowResize);

  // リアクションボタン
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      
      switch(type) {
        case 'penlight':
          penlightOn = !penlightOn;
          myPenlight.visible = penlightOn;
          document.getElementById('penlight-colors').classList.toggle('hidden', !penlightOn);
          if (penlightOn) {
            wavePenlight();
          }
          break;
        case 'jump':
          doJump();
          break;
        case 'clap':
          doClap();
          break;
        case 'otagei':
          doOtagei(btn.dataset.motion);
          break;
      }
    });
  });

  // ペンライト色選択
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      setPenlightColor(btn.dataset.color);
      wavePenlight();
    });
  });

  // チャット送信
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (message) {
      addChatMessage(myUserName, message);
      input.value = '';
    }
  });

  // 登壇リクエスト
  document.getElementById('request-stage-btn').addEventListener('click', () => {
    alert('登壇リクエストを送信しました（デモ）');
  });

  // マイクトグル
  document.getElementById('mic-toggle-btn').addEventListener('click', (e) => {
    e.target.classList.toggle('muted');
    const isMuted = e.target.classList.contains('muted');
    e.target.textContent = isMuted ? '🎙️ マイク OFF' : '🎙️ マイク ON';
  });

  // タッチでアバター移動
  let touchStartX, touchStartY;
  renderer.domElement.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });

  renderer.domElement.addEventListener('touchmove', (e) => {
    if (!touchStartX || !touchStartY) return;
    
    const deltaX = (e.touches[0].clientX - touchStartX) * 0.01;
    const deltaZ = (e.touches[0].clientY - touchStartY) * 0.01;
    
    myAvatar.position.x += deltaX;
    myAvatar.position.z += deltaZ;
    
    myAvatar.position.x = Math.max(-14, Math.min(14, myAvatar.position.x));
    myAvatar.position.z = Math.max(-2, Math.min(9, myAvatar.position.z));
    
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });

  renderer.domElement.addEventListener('touchend', () => {
    touchStartX = null;
    touchStartY = null;
  });
}

// --------------------------------------------
// チャットメッセージ追加
// --------------------------------------------
function addChatMessage(name, message) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-message';
  div.innerHTML = `<span class="name">${name}</span>${message}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  
  while (container.children.length > 20) {
    container.removeChild(container.firstChild);
  }
}

// --------------------------------------------
// ウィンドウリサイズ
// --------------------------------------------
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --------------------------------------------
// アニメーションループ
// --------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  
  const targetX = myAvatar.position.x * 0.3;
  const targetZ = myAvatar.position.z + 8;
  camera.position.x += (targetX - camera.position.x) * 0.05;
  camera.position.z += (targetZ - camera.position.z) * 0.05;
  camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
  
  renderer.render(scene, camera);
}

// --------------------------------------------
// 初期化実行
// --------------------------------------------
init();
