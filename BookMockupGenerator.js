/**
 * BookMockupGenerator.js
 *
 * Three.js BoxGeometry 기반 3D 북 목업 생성기
 *
 * 렌더링 방식:
 * 1. 책을 Y축으로 회전시키고(기본 30도), 정면 축 위의 망원 카메라(FOV 14도)로
 *    렌더링 → 키스톤 왜곡 없이 표지가 직사각형을 유지
 * 2. 투명 픽셀을 트림해 책의 실제 경계 상자를 구함
 * 3. 정사각 투명 캔버스에 책 높이가 캔버스의 75%가 되도록 스케일해
 *    가로 중앙에 배치
 */

/**
 * 이미지를 Three.js 텍스처로 변환
 */
function createTexture(img) {
    const texture = new THREE.Texture(img);
    texture.needsUpdate = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
}

/**
 * 3D 북 목업 렌더링
 *
 * @param {HTMLImageElement|HTMLCanvasElement} frontImg - 앞표지 이미지
 * @param {HTMLImageElement|HTMLCanvasElement} spineImg - 책등 이미지
 * @param {number} frontW - 앞표지 너비 (px)
 * @param {number} spineW - 책등 너비 (px)
 * @param {number} H - 높이 (px)
 * @param {Object} options
 * @param {number} [options.rotationY=Math.PI/6] - Y축 회전 (라디안, 기본 30도)
 * @param {number} [options.sizeRatio=0.75] - 캔버스 높이 대비 책 높이 비율
 * @param {number} [options.posX=0.5] - 책 중심의 가로 위치 (0~1, 0.5=중앙)
 * @param {number} [options.outputScale=1] - 출력 스케일
 * @returns {Promise<Blob>}
 */
export async function renderBookMockup(frontImg, spineImg, frontW, spineW, H, options = {}) {
    const rotationY = options.rotationY ?? Math.PI / 6;  // 30도
    const sizeRatio = options.sizeRatio ?? 0.75;
    const posX = options.posX ?? 0.5;
    const outputScale = options.outputScale ?? 1;

    // 단위 변환 (1000px = 1 unit)
    const scale = 1 / 1000;
    const bookWidth = frontW * scale;   // 표지 너비 = Box의 X
    const bookHeight = H * scale;       // 높이 = Box의 Y
    const bookDepth = spineW * scale;   // 책등 두께 = Box의 Z

    // =========================================================================
    // 1. BoxGeometry + 6면 Material
    // =========================================================================
    // BoxGeometry 면 순서: [+X, -X, +Y, -Y, +Z, -Z]
    // - 앞(+Z, index 4) = 표지
    // - 왼쪽(-X, index 1) = 책등 (표지와 면 구분되도록 살짝 어둡게)
    // - 나머지 = 종이색 (위/아래/책배/뒤)

    const geometry = new THREE.BoxGeometry(bookWidth, bookHeight, bookDepth);

    const coverTexture = createTexture(frontImg);
    const spineTexture = createTexture(spineImg);

    const paperMaterial = new THREE.MeshBasicMaterial({ color: 0xf7f6f2 });

    const materials = [
        paperMaterial,                                                          // 0: +X (책배)
        new THREE.MeshBasicMaterial({ map: spineTexture, color: 0xdedede }),    // 1: -X = 책등
        paperMaterial,                                                          // 2: +Y (위)
        paperMaterial,                                                          // 3: -Y (아래)
        new THREE.MeshBasicMaterial({ map: coverTexture }),                     // 4: +Z = 표지
        paperMaterial                                                           // 5: -Z (뒤)
    ];

    const book = new THREE.Mesh(geometry, materials);
    book.rotation.y = rotationY;

    const scene = new THREE.Scene();
    scene.background = null;
    scene.add(book);

    // =========================================================================
    // 2. Camera - 정면 축 위의 망원 카메라 (왜곡 최소화)
    // =========================================================================

    const fov = 14;
    const halfTan = Math.tan(fov / 2 * Math.PI / 180);
    const aspect = 0.85;

    // 회전된 책의 가로 절반 폭
    const halfWrot = (bookWidth * Math.cos(rotationY) + bookDepth * Math.sin(rotationY)) / 2;
    const margin = 1.12;
    const distV = (bookHeight / 2) * margin / halfTan;
    const distH = halfWrot * margin / (halfTan * aspect);
    const dist = Math.max(distV, distH) + bookDepth;

    const renderHeight = Math.ceil(H * outputScale * margin);
    const renderWidth = Math.round(renderHeight * aspect);

    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, dist * 4);
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);

    // =========================================================================
    // 3. Renderer
    // =========================================================================

    const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true
    });
    renderer.setSize(renderWidth, renderHeight);
    renderer.setPixelRatio(1);

    renderer.render(scene, camera);

    // =========================================================================
    // 4. 투명 픽셀 트림 → 책의 실제 경계 상자
    // =========================================================================

    const src2d = document.createElement('canvas');
    src2d.width = renderWidth;
    src2d.height = renderHeight;
    const sctx = src2d.getContext('2d');
    sctx.drawImage(renderer.domElement, 0, 0);
    const data = sctx.getImageData(0, 0, renderWidth, renderHeight).data;

    let minX = renderWidth, minY = renderHeight, maxX = -1, maxY = -1;
    for (let y = 0; y < renderHeight; y++) {
        for (let x = 0; x < renderWidth; x++) {
            if (data[(y * renderWidth + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    // 3D 리소스 정리
    geometry.dispose();
    materials.forEach(m => m.dispose());
    coverTexture.dispose();
    spineTexture.dispose();
    renderer.dispose();

    if (maxX < 0) {
        throw new Error('목업 렌더링 결과가 비어 있습니다.');
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // =========================================================================
    // 5. 정사각 캔버스에 배치 (높이 sizeRatio, 가로 posX 중심)
    // =========================================================================

    const canvasSize = Math.ceil(bh / sizeRatio);
    const targetH = canvasSize * sizeRatio;
    const targetW = targetH * bw / bh;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = canvasSize;
    outCanvas.height = canvasSize;
    const octx = outCanvas.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(
        src2d,
        minX, minY, bw, bh,
        canvasSize * posX - targetW / 2,
        (canvasSize - targetH) / 2,
        targetW, targetH
    );

    return new Promise((resolve) => {
        outCanvas.toBlob(resolve, 'image/png');
    });
}
