// ============================================
// 会場装飾（Three.js）
// ============================================

import { debugLog } from './utils.js';

let THREE;
let scene;
let ledScreen;
let mirrorBall;
let movingLights = [];
let mirrorBallLights = [];
let floorLightSpots = [];
let lightTime = 0;

let stageBackgroundUrl = 'https://raw.githubusercontent.com/kimura-jane/meta/main/IMG_3206.jpeg';

export function initVenue(threeInstance, sceneInstance) {
    THREE = threeInstance;
    scene = sceneInstance;
}

export function createAllVenue() {
    createZeppFloor();
    createZeppStage();
    createVenueWalls();
    createTruss();
    createMovingLights();
    createBarrier();
    createSideSpeakers();
    createMirrorBall();
}

export function animateVenue() {
    lightTime += 0.02;
    
    // ステージ上のムービングライト
    movingLights.forEach((ml) => {
        const swingX = Math.sin(lightTime + ml.phase) * 3;
        const swingZ = Math.cos(lightTime * 0.7 + ml.phase) * 2;
        ml.light.target.position.set(ml.baseX + swingX, 0, 2 + swingZ);
    });

    // ミラーボール回転
    if (mirrorBall) {
        mirrorBall.rotation.y += 0.01;
    }

    // ミラーボールからの光
    mirrorBallLights.forEach((ml) => {
        const angle = ml.baseAngle + lightTime * 0.5;
        ml.target.position.set(
            Math.cos(angle) * 12,
            0,
            Math.sin(angle) * 12 + 3
        );
    });

    // 床の光スポット移動
    floorLightSpots.forEach((spot) => {
        const offset = Math.sin(lightTime * spot.speed + spot.phase) * 2;
        spot.mesh.position.x = spot.baseX + offset;
        spot.mesh.position.z = spot.baseZ + Math.cos(lightTime * spot.speed * 0.7 + spot.phase) * 1.5;
        spot.mesh.material.opacity = 0.4 + Math.sin(lightTime * 2 + spot.phase) * 0.2;
    });
}

// --------------------------------------------
// Zepp風フロア
// --------------------------------------------
function createZeppFloor() {
    const floorGeometry = new THREE.PlaneGeometry(30, 25);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x0a0a0a, roughness: 0.3, metalness: 0.7
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // ネオンライン
    [-8, -4, 0, 4, 8].forEach((x, i) => {
        const lineGeometry = new THREE.PlaneGeometry(0.05, 20);
        const lineMaterial = new THREE.MeshBasicMaterial({ 
            color: i % 2 === 0 ? 0xff00ff : 0x00ffff, transparent: true, opacity: 0.4
        });
        const line = new THREE.Mesh(lineGeometry, lineMaterial);
        line.rotation.x = -Math.PI / 2;
        line.position.set(x, 0.01, 2);
        scene.add(line);
    });

    // 床の光スポット
    const spotColors = [0xff0066, 0xff00ff, 0x00ffff, 0xffff00, 0xff6600, 0x00ff66];
    for (let i = 0; i < 20; i++) {
        const spotGeo = new THREE.CircleGeometry(0.3 + Math.random() * 0.4, 16);
        const spotMat = new THREE.MeshBasicMaterial({ 
            color: spotColors[Math.floor(Math.random() * spotColors.length)],
            transparent: true,
            opacity: 0.6
        });
        const spot = new THREE.Mesh(spotGeo, spotMat);
        spot.rotation.x = -Math.PI / 2;
        spot.position.set(
            (Math.random() - 0.5) * 20,
            0.02,
            (Math.random() - 0.5) * 15 + 3
        );
        scene.add(spot);
        floorLightSpots.push({
            mesh: spot,
            baseX: spot.position.x,
            baseZ: spot.position.z,
            speed: 0.5 + Math.random() * 1,
            phase: Math.random() * Math.PI * 2
        });
    }
}

// --------------------------------------------
// 会場の壁
// --------------------------------------------
function createVenueWalls() {
    const wallMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x2a2a3e, roughness: 0.7, metalness: 0.3
    });

    // 後方の壁
    const backWall = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 12),
        wallMaterial
    );
    backWall.position.set(0, 6, 15);
    backWall.rotation.y = Math.PI;
    scene.add(backWall);

    // 後方壁を照らすライト
    const backLight = new THREE.SpotLight(0x4444ff, 2, 20, Math.PI / 3, 0.5);
    backLight.position.set(0, 10, 10);
    backLight.target.position.set(0, 5, 15);
    scene.add(backLight);
    scene.add(backLight.target);

    // 左右の壁
    [-14, 14].forEach((x, idx) => {
        const sideWall = new THREE.Mesh(
            new THREE.PlaneGeometry(25, 12),
            wallMaterial.clone()
        );
        sideWall.position.set(x, 6, 2);
        sideWall.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
        scene.add(sideWall);

        // 壁を照らすウォッシュライト
        const wallLight = new THREE.SpotLight(
            x < 0 ? 0x6600ff : 0x0066ff, 
            3, 
            25, 
            Math.PI / 2.5, 
            0.5
        );
        wallLight.position.set(x * 0.5, 9, 2);
        wallLight.target.position.set(x, 4, 2);
        scene.add(wallLight);
        scene.add(wallLight.target);

        createGeometricPanels(x, idx);
    });

    // 天井
    const ceiling = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 25),
        new THREE.MeshStandardMaterial({ color: 0x151520 })
    );
    ceiling.position.set(0, 10, 2);
    ceiling.rotation.x = Math.PI / 2;
    scene.add(ceiling);
}

// --------------------------------------------
// 幾何学模様パネル
// --------------------------------------------
function createGeometricPanels(wallX, wallIdx) {
    const panelColors = [0x6600ff, 0x8800ff, 0xaa00ff, 0x4400ff];
    const isLeft = wallX < 0;
    
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
            const triGeo = new THREE.BufferGeometry();
            const size = 1.8;
            const vertices = new Float32Array([
                0, size, 0,
                -size * 0.866, -size * 0.5, 0,
                size * 0.866, -size * 0.5, 0
            ]);
            triGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            triGeo.computeVertexNormals();
            
            const triMat = new THREE.MeshBasicMaterial({ 
                color: panelColors[(row + col) % panelColors.length],
                transparent: true,
                opacity: 0.6 + Math.random() * 0.3,
                side: THREE.DoubleSide
            });
            
            const tri = new THREE.Mesh(triGeo, triMat);
            tri.position.set(
                isLeft ? wallX + 0.2 : wallX - 0.2,
                2.5 + row * 2.8,
                -4 + col * 3.5
            );
            tri.rotation.y = isLeft ? Math.PI / 2 : -Math.PI / 2;
            tri.rotation.z = ((row + col) % 2) * Math.PI;
            scene.add(tri);

            if ((row + col) % 3 === 0) {
                const pointLight = new THREE.PointLight(
                    panelColors[(row + col) % panelColors.length],
                    0.5,
                    5
                );
                pointLight.position.set(
                    isLeft ? wallX + 1 : wallX - 1,
                    2.5 + row * 2.8,
                    -4 + col * 3.5
                );
                scene.add(pointLight);
            }
        }
    }

    // ネオンフレーム
    const frameMat = new THREE.MeshBasicMaterial({ 
        color: 0x00ffff, transparent: true, opacity: 0.8 
    });
    
    [2, 5, 8].forEach(y => {
        const hLine = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 0.08, 15),
            frameMat
        );
        hLine.position.set(isLeft ? wallX + 0.3 : wallX - 0.3, y, 2);
        scene.add(hLine);
    });

    [-4, 0, 4, 8].forEach(z => {
        const vLine = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 8, 0.08),
            new THREE.MeshBasicMaterial({ 
                color: 0xff00ff, transparent: true, opacity: 0.6 
            })
        );
        vLine.position.set(isLeft ? wallX + 0.3 : wallX - 0.3, 5, z);
        scene.add(vLine);
    });
}

// --------------------------------------------
// ミラーボール
// --------------------------------------------
function createMirrorBall() {
    const ballGeo = new THREE.SphereGeometry(0.8, 32, 32);
    const ballMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 1,
        roughness: 0.1
    });
    mirrorBall = new THREE.Mesh(ballGeo, ballMat);
    mirrorBall.position.set(0, 9, 3);
    scene.add(mirrorBall);

    const tileCount = 200;
    for (let i = 0; i < tileCount; i++) {
        const phi = Math.acos(-1 + (2 * i) / tileCount);
        const theta = Math.sqrt(tileCount * Math.PI) * phi;
        
        const tileGeo = new THREE.PlaneGeometry(0.15, 0.15);
        const tileMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide
        });
        const tile = new THREE.Mesh(tileGeo, tileMat);
        
        tile.position.setFromSphericalCoords(0.82, phi, theta);
        tile.lookAt(0, 0, 0);
        mirrorBall.add(tile);
    }

    const wire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 1.5, 8),
        new THREE.MeshBasicMaterial({ color: 0x333333 })
    );
    wire.position.set(0, 9.75, 3);
    scene.add(wire);

    const spotLight = new THREE.SpotLight(0xffffff, 3, 15, Math.PI / 4, 0.5);
    spotLight.position.set(0, 10, 3);
    spotLight.target = mirrorBall;
    scene.add(spotLight);

    const lightColors = [0xff0066, 0x00ffff, 0xffff00, 0xff00ff, 0x00ff66, 0xff6600];
    for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const light = new THREE.SpotLight(
            lightColors[i % lightColors.length],
            0.5,
            20,
            Math.PI / 16,
            0.8
        );
        light.position.set(0, 9, 3);
        
        const target = new THREE.Object3D();
        target.position.set(
            Math.cos(angle) * 10,
            0,
            Math.sin(angle) * 10 + 3
        );
        scene.add(target);
        light.target = target;
        scene.add(light);
        
        mirrorBallLights.push({ light, target, baseAngle: angle });
    }
}

// --------------------------------------------
// Zepp風ステージ
// --------------------------------------------
function createZeppStage() {
    const stageGeometry = new THREE.BoxGeometry(16, 1.2, 6);
    const stageMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x1a1a1a, roughness: 0.3, metalness: 0.5
    });
    const stage = new THREE.Mesh(stageGeometry, stageMaterial);
    stage.position.set(0, 0.6, -6);
    stage.castShadow = true;
    stage.receiveShadow = true;
    scene.add(stage);

    const edgeMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    const stageEdge = new THREE.Mesh(new THREE.BoxGeometry(16, 0.1, 0.1), edgeMaterial);
    stageEdge.position.set(0, 1.25, -3.05);
    scene.add(stageEdge);

    const underLight = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 0.5),
        new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.5 })
    );
    underLight.rotation.x = -Math.PI / 2;
    underLight.position.set(0, 0.02, -3.2);
    scene.add(underLight);

    // LEDスクリーン
    const screenGeometry = new THREE.PlaneGeometry(14, 6);
    const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x330066, side: THREE.DoubleSide });
    ledScreen = new THREE.Mesh(screenGeometry, screenMaterial);
    ledScreen.position.set(0, 4, -8.5);
    scene.add(ledScreen);
    
    const loader = new THREE.TextureLoader();
    loader.load(stageBackgroundUrl, function(texture) {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        
        ledScreen.material.dispose();
        ledScreen.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        debugLog('背景画像ロード成功', 'success');
    }, undefined, function(err) {
        debugLog('背景画像ロード失敗: ' + err, 'warn');
    });

    const frame = new THREE.Mesh(
        new THREE.BoxGeometry(14.4, 6.4, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    frame.position.set(0, 4, -8.6);
    scene.add(frame);
}

export function changeStageBackground(imageUrl) {
    stageBackgroundUrl = imageUrl;
    const loader = new THREE.TextureLoader();
    loader.load(imageUrl, function(texture) {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        
        if (ledScreen) {
            ledScreen.material.dispose();
            ledScreen.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
            debugLog('背景変更成功', 'success');
        }
    }, undefined, function(err) {
        debugLog('背景変更失敗: ' + err, 'warn');
    });
}

// --------------------------------------------
// トラス
// --------------------------------------------
function createTruss() {
    const trussMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x222222, roughness: 0.5, metalness: 0.8
    });

    const mainTruss = new THREE.Mesh(new THREE.BoxGeometry(18, 0.3, 0.3), trussMaterial);
    mainTruss.position.set(0, 8, -5);
    scene.add(mainTruss);

    const frontTruss = new THREE.Mesh(new THREE.BoxGeometry(18, 0.3, 0.3), trussMaterial);
    frontTruss.position.set(0, 7, 0);
    scene.add(frontTruss);

    [-9, 9].forEach(x => {
        const sideTruss = new THREE.Mesh(new THREE.BoxGeometry(0.3, 8, 0.3), trussMaterial);
        sideTruss.position.set(x, 4, -5);
        scene.add(sideTruss);
    });
}

// --------------------------------------------
// ムービングライト
// --------------------------------------------
function createMovingLights() {
    const colors = [0x9900ff, 0xff00ff, 0x00ffff, 0xff00ff, 0x9900ff];
    [-6, -3, 0, 3, 6].forEach((x, i) => {
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.3, 0.5, 8),
            new THREE.MeshStandardMaterial({ color: 0x111111 })
        );
        body.position.set(x, 7.7, -5);
        scene.add(body);

        const spotLight = new THREE.SpotLight(colors[i], 2, 20, Math.PI / 6, 0.5, 1);
        spotLight.position.set(x, 7.5, -5);
        spotLight.target.position.set(x, 0, 2);
        spotLight.castShadow = true;
        scene.add(spotLight);
        scene.add(spotLight.target);

        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(0.15, 0.4, 8),
            new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.8 })
        );
        cone.position.set(x, 7.3, -5);
        cone.rotation.x = Math.PI;
        scene.add(cone);

        movingLights.push({ light: spotLight, baseX: x, phase: i * 0.5 });
    });

    [-4, 0, 4].forEach((x, i) => {
        const spotLight = new THREE.SpotLight([0x00ffff, 0xff00ff, 0x00ffff][i], 1.5, 15, Math.PI / 8, 0.5, 1);
        spotLight.position.set(x, 6.8, 0);
        spotLight.target.position.set(x, 0, 5);
        scene.add(spotLight);
        scene.add(spotLight.target);
    });
}

// --------------------------------------------
// バリケード
// --------------------------------------------
function createBarrier() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.7 });
    for (let x = -7; x <= 7; x += 2) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), mat);
        post.position.set(x, 0.5, -2);
        scene.add(post);
        if (x < 7) {
            const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2, 8), mat);
            rail.rotation.z = Math.PI / 2;
            rail.position.set(x + 1, 0.8, -2);
            scene.add(rail);
        }
    }
}

// --------------------------------------------
// サイドスピーカー
// --------------------------------------------
function createSideSpeakers() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3 });
    [-7.5, 7.5].forEach(x => {
        const speaker = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 1), mat);
        speaker.position.set(x, 2.5, -4);
        scene.add(speaker);

        const grill = new THREE.Mesh(
            new THREE.PlaneGeometry(1.3, 2.3),
            new THREE.MeshBasicMaterial({ color: 0x0a0a0a, side: THREE.DoubleSide })
        );
        grill.position.set(x, 2.5, -3.49);
        scene.add(grill);

        const sub = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 1.2), mat);
        sub.position.set(x, 0.6, -4);
        scene.add(sub);
    });
}
