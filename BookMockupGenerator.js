/**
 * BookMockupGenerator.js
 *
 * Three.js BoxGeometry 기반 3D 북 목업 생성기
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
 * @param {number} [options.rotationY=0.5] - Y축 회전 (라디안, 0.5 ≈ 28도)
 * @param {number} [options.outputScale=1] - 출력 스케일
 * @returns {Promise<Blob>}
 */
export async function renderBookMockup(frontImg, spineImg, frontW, spineW, H, options = {}) {
    const rotationY = options.rotationY ?? 0.08;  // 약 5도 (최소)
    const outputScale = options.outputScale ?? 1;

    // 단위 변환 (1000px = 1 unit)
    const scale = 1 / 1000;
    const bookWidth = frontW * scale;   // 표지 너비 = Box의 X
    const bookHeight = H * scale;       // 높이 = Box의 Y
    const bookDepth = spineW * scale;   // 책등 두께 = Box의 Z

    // Scene
    const scene = new THREE.Scene();
    scene.background = null;

    // =========================================================================
    // 1. BoxGeometry + 6면 Material
    // =========================================================================
    // BoxGeometry 면 순서: [+X, -X, +Y, -Y, +Z, -Z]
    // 즉: [오른쪽, 왼쪽, 위, 아래, 앞, 뒤]
    //
    // 우리가 필요한 것:
    // - 앞(+Z, index 4) = 표지
    // - 왼쪽(-X, index 1) = 책등
    // - 나머지 = 투명

    const geometry = new THREE.BoxGeometry(bookWidth, bookHeight, bookDepth);

    const coverTexture = createTexture(frontImg);
    const spineTexture = createTexture(spineImg);

    // 투명 재질
    const transparentMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0
    });

    // 6면 재질 배열
    const materials = [
        transparentMaterial,  // 0: +X (오른쪽) - 안 보임
        new THREE.MeshBasicMaterial({ map: spineTexture }),  // 1: -X (왼쪽) = 책등
        transparentMaterial,  // 2: +Y (위) - 안 보임
        transparentMaterial,  // 3: -Y (아래) - 안 보임
        new THREE.MeshBasicMaterial({ map: coverTexture }),  // 4: +Z (앞) = 표지
        transparentMaterial   // 5: -Z (뒤) - 안 보임
    ];

    const book = new THREE.Mesh(geometry, materials);

    // Y축 회전 (책을 돌려서 책등이 보이게)
    book.rotation.y = rotationY;

    scene.add(book);

    // =========================================================================
    // 2. Camera - PerspectiveCamera (원근감 있게)
    // =========================================================================

    // 렌더링 크기 계산 - 책 비율에 맞게
    const renderHeight = Math.ceil(H * outputScale);
    const renderWidth = Math.ceil(renderHeight * 0.9);  // 세로로 더 길게

    const aspect = renderWidth / renderHeight;

    const camera = new THREE.PerspectiveCamera(
        60,      // FOV 넓게 (더 많이 보임)
        aspect,
        0.1,
        100
    );

    // 카메라 위치 - 더더 가까이, 살짝 오른쪽
    const camDistance = bookHeight * 0.95;
    camera.position.set(-bookWidth * 0.85, bookHeight * 0.03, camDistance);
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
    // 4. Export
    // =========================================================================

    return new Promise((resolve) => {
        renderer.domElement.toBlob((blob) => {
            // 정리
            geometry.dispose();
            materials.forEach(m => m.dispose());
            coverTexture.dispose();
            spineTexture.dispose();
            renderer.dispose();

            resolve(blob);
        }, 'image/png');
    });
}
