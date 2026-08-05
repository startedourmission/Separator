/**
 * BookMockupGenerator.js
 *
 * 디자이너식 2.5D 북 목업 생성기 (면별 원근 워프)
 *
 * 실물 상자를 통째로 회전하면 책등이 좁아져 잘 안 보인다. 디자이너 목업은
 * 책등·표지를 각각 따로 기울여 둘 다 잘 보이게 만든 비물리적 형상을 쓴다.
 * 레퍼런스 목업(잘된버전.psd)을 실측한 값:
 * - 책등·표지 모두 실제 폭의 약 73~75%로 압축 (같은 비율 → 책등이 물리보다 넓게 보임)
 * - 세로 원근: 표지 바깥 모서리 높이 88%, 책등 바깥 모서리 96% (접합선이 가장 큼)
 * - 두 면은 접합선에서 만나고 세로 중심선을 공유
 *
 * 각 면은 원근 보정 스트립(1/h 선형 보간)으로 워프해 그린다. WebGL 불필요.
 */

/**
 * 한 면을 원근 워프로 그린다.
 *
 * 접합선(joint) 쪽 높이 hNear에서 바깥 모서리 높이 hFar로 줄어드는
 * 대칭 사다리꼴에 소스 이미지를 투영한다. 원근 보정: 1/h가 화면 x에
 * 선형이 되도록 소스 u좌표를 비선형 샘플링한다.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement|HTMLCanvasElement} img - 소스 (세로 전체 사용)
 * @param {number} jointX - 접합선의 x 좌표
 * @param {number} destW - 면의 목표 폭 (px)
 * @param {number} hNear - 접합선 쪽 높이
 * @param {number} hFar - 바깥 모서리 높이
 * @param {number} midY - 세로 중심선 y
 * @param {number} dir - +1: 접합선에서 오른쪽으로(표지), -1: 왼쪽으로(책등)
 */
function drawFacePerspective(ctx, img, jointX, destW, hNear, hFar, midY, dir) {
    const srcW = img.width;
    const q0 = 1 / hNear;
    const q1 = 1 / hFar;

    // 소스 u좌표: 원근 보정 보간 u/w = (q - q0) / (q1 - q0)
    const uAt = (t) => {
        const q = q0 + (q1 - q0) * t;
        return srcW * (q - q0) / (q1 - q0 || 1e-9);
    };

    const steps = Math.max(8, Math.ceil(destW));
    for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const q = q0 + (q1 - q0) * (t0 + t1) / 2;
        const h = 1 / q;
        const u0 = uAt(t0);
        const u1 = uAt(t1);

        const x = dir > 0
            ? jointX + t0 * destW
            : jointX - t1 * destW;
        const w = (t1 - t0) * destW;
        // 소스가 표지(dir>0)는 왼쪽부터, 책등(dir<0)은 오른쪽부터 접합선
        const su = dir > 0 ? u0 : srcW - u1;

        ctx.drawImage(
            img,
            su, 0, Math.max(u1 - u0, 0.01), img.height,
            x, midY - h / 2, w + 0.35, h  // +0.35: 스트립 간 미세 틈 방지
        );
    }
}

/**
 * 2.5D 북 목업 렌더링
 *
 * @param {HTMLImageElement|HTMLCanvasElement} frontImg - 앞표지 이미지
 * @param {HTMLImageElement|HTMLCanvasElement} spineImg - 책등 이미지
 * @param {number} frontW - 앞표지 너비 (px)
 * @param {number} spineW - 책등 너비 (px)
 * @param {number} H - 높이 (px)
 * @param {Object} options
 * @param {number} [options.coverWidthFactor=0.733] - 표지 폭 압축 비율
 * @param {number} [options.spineWidthFactor=0.755] - 책등 폭 압축 비율
 * @param {number} [options.coverEdgeRatio=0.84] - 표지 바깥 모서리 높이 / 접합선 높이
 * @param {number} [options.spineEdgeRatio=0.947] - 책등 바깥 모서리 높이 / 접합선 높이
 * @param {number} [options.spineBrightness=0.87] - 책등 밝기 (면 구분용)
 * @param {number} [options.sizeRatio=0.75] - 캔버스 높이 대비 책 높이 비율
 * @param {number} [options.posX=0.5] - 책 중심의 가로 위치 (0~1, 0.5=중앙)
 * @param {number} [options.outputScale=1] - 출력 스케일
 * @returns {Promise<Blob>}
 */
export async function renderBookMockup(frontImg, spineImg, frontW, spineW, H, options = {}) {
    const coverWidthFactor = options.coverWidthFactor ?? 0.733;
    const spineWidthFactor = options.spineWidthFactor ?? 0.755;
    const coverEdgeRatio = options.coverEdgeRatio ?? 0.84;
    const spineEdgeRatio = options.spineEdgeRatio ?? 0.947;
    const spineBrightness = options.spineBrightness ?? 0.87;
    const sizeRatio = options.sizeRatio ?? 0.75;
    const posX = options.posX ?? 0.5;
    const outputScale = options.outputScale ?? 1;

    // =========================================================================
    // 1. 책 본체 렌더 (접합선 기준 좌: 책등, 우: 표지)
    // =========================================================================

    const jointH = H * outputScale;                              // 접합선 높이 (가장 큼)
    const coverDestW = frontW * outputScale * coverWidthFactor;
    const spineDestW = spineW * outputScale * spineWidthFactor;

    const bookW = Math.ceil(spineDestW + coverDestW);
    const bookH = Math.ceil(jointH);
    const midY = bookH / 2;
    const jointX = spineDestW;

    const bookCanvas = document.createElement('canvas');
    bookCanvas.width = bookW;
    bookCanvas.height = bookH;
    const bctx = bookCanvas.getContext('2d');
    bctx.imageSmoothingQuality = 'high';

    // 책등 (접합선에서 왼쪽으로, 살짝 어둡게 해 면 구분)
    bctx.filter = `brightness(${spineBrightness})`;
    drawFacePerspective(bctx, spineImg, jointX, spineDestW, jointH, jointH * spineEdgeRatio, midY, -1);
    bctx.filter = 'none';

    // 표지 (접합선에서 오른쪽으로)
    drawFacePerspective(bctx, frontImg, jointX, coverDestW, jointH, jointH * coverEdgeRatio, midY, +1);

    // =========================================================================
    // 2. 정사각 캔버스에 배치 (높이 sizeRatio, 가로 posX 중심)
    // =========================================================================

    const canvasSize = Math.ceil(bookH / sizeRatio);
    const outCanvas = document.createElement('canvas');
    outCanvas.width = canvasSize;
    outCanvas.height = canvasSize;
    const octx = outCanvas.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(
        bookCanvas,
        canvasSize * posX - bookW / 2,
        (canvasSize - bookH) / 2
    );

    return new Promise((resolve) => {
        outCanvas.toBlob(resolve, 'image/png');
    });
}
