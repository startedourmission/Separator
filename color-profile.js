/**
 * Japan Color 2001 Coated 근사 CMYK → sRGB 변환.
 *
 * 기존 변환은 순수 보색 반전(R = 255*(1-C)*(1-K))이라 C100%가 RGB(0,255,255)
 * 같은 형광색으로 나왔다. 실제 인쇄 잉크는 그렇게 채도가 높지 않아 아크로뱃
 * (문서 output intent를 ICC로 소프트프루핑)보다 훨씬 쨍하게 보이는 원인이었다.
 *
 * 여기서는 Japan Color 2001 Coated의 측정 Lab 값을 sRGB로 변환한 8개 꼭짓점
 * (백지 / C / M / Y / CM / CY / MY / CMY)을 기준으로 CMY 공간을 삼선형 보간하고,
 * K는 별도 감쇠 곡선으로 곱한다. ICC LUT 대비 ΔE 3~5 수준이지만, 문제였던
 * "형광색으로 뜬다"(ΔE 30+)는 확실히 잡힌다.
 *
 * 색을 정의하는 곳(computeJapanColorRGB)과 런타임 조회 경로(룩업 테이블)를 분리해 뒀다.
 * 실제 ICC(A2B0 LUT) 변환으로 갈아타려면 computeJapanColorRGB()만 교체하면 된다.
 */

// Japan Color 2001 Coated 기준 잉크 조합별 측정 Lab (D50, 100% 도포)
// 출처: Japan Color 2001 Coated 특성 데이터(ISO 12642 IT8.7/3 패치)의 대표값
const CORNER_LAB = {
    white: { L: 95.0, a: 0.0, b: -2.0 },      // 코팅지 백색 (기준화되어 화면엔 순백으로 나옴)
    c: { L: 55.3, a: -37.0, b: -50.2 },      // Cyan 100%
    m: { L: 48.3, a: 74.2, b: -3.5 },      // Magenta 100%
    y: { L: 89.0, a: -5.1, b: 93.0 },      // Yellow 100%
    cm: { L: 24.5, a: 22.0, b: -46.3 },      // Blue (C+M)
    cy: { L: 48.7, a: -66.0, b: 25.5 },      // Green (C+Y)
    my: { L: 46.7, a: 68.0, b: 48.3 },      // Red (M+Y)
    cmy: { L: 22.0, a: 1.5, b: 0.5 }        // Composite black (C+M+Y)
};

// K 100% 단독의 밝기 — 순수 검정이 아니라 L*≈16 수준
const K_SOLID_L = 16.0;

/* ---------------------------------------------------------------- 색공간 변환 */

// CIE Lab (D50) → XYZ
function labToXYZ({ L, a, b }) {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;

    const f = (t) => {
        const t3 = t * t * t;
        return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
    };

    // D50 백색점
    return { X: 0.96422 * f(fx), Y: 1.0 * f(fy), Z: 0.82521 * f(fz) };
}

// XYZ(D50) → 선형 sRGB. Bradford 적응이 포함된 D50→sRGB 매트릭스.
function xyzToLinearRGB({ X, Y, Z }) {
    return {
        r: 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z,
        g: -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z,
        b: 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z
    };
}

// 선형 → sRGB 감마 인코딩
function encodeGamma(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Lab → 선형 sRGB (보간은 선형 광량 공간에서 해야 중간색이 탁해지지 않는다)
function labToLinearRGB(lab) {
    const { r, g, b } = xyzToLinearRGB(labToXYZ(lab));
    return { r: Math.max(0, r), g: Math.max(0, g), b: Math.max(0, b) };
}

/* ------------------------------------------------------- 꼭짓점 사전 계산 */

/**
 * 백색점 기준화(white point normalization).
 *
 * 측정 Lab을 그대로 쓰면 백지가 rgb(239,241,244)로 나온다. 실제 코팅지가 순백보다
 * 어둡고 살짝 푸른 건 맞지만, 화면에서는 흰 배경이 회청색으로 뜨는 것으로만 보인다.
 * 아크로뱃도 "용지 흰색 시뮬레이션"을 켰을 때만 이렇게 보여주고, 기본값은 꺼짐이다.
 *
 * 그래서 백지가 정확히 흰색(1,1,1)이 되도록 모든 꼭짓점을 백지 기준으로 나눈다.
 * 잉크 사이의 상대 관계(채도·색상)는 그대로 유지되고 용지색만 빠진다.
 */
const WHITE_LINEAR = labToLinearRGB(CORNER_LAB.white);

function normalizeToPaperWhite({ r, g, b }) {
    return {
        r: r / WHITE_LINEAR.r,
        g: g / WHITE_LINEAR.g,
        b: b / WHITE_LINEAR.b
    };
}

const CORNER_RGB = {};
for (const [key, lab] of Object.entries(CORNER_LAB)) {
    CORNER_RGB[key] = normalizeToPaperWhite(labToLinearRGB(lab));
}

// K 단독 솔리드의 밝기 — 기준화 후이므로 그대로 백지 대비 비율이 된다
const K_SOLID_RGB = normalizeToPaperWhite(labToLinearRGB({ L: K_SOLID_L, a: 0, b: 0 }));

/* ------------------------------------------------------------ 잉크 도트 게인 */

/**
 * 망점 면적률 → 실효 잉크 피복률.
 * 인쇄에서는 망점이 번져 50% 망점이 대략 68% 농도로 나온다(도트 게인).
 * 아크로뱃 소프트프루프도 프로파일의 TRC를 통해 이 효과를 반영한다.
 */
function applyDotGain(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // 중간톤에서 최대 약 +26% 게인. 계수는 Japan Color 참조 패치(C50/M50/K50 등)와의
    // 평균 오차가 최소가 되는 값을 실측해서 골랐다(0.14→19.4, 0.26→13.4, 0.30→14.4).
    const gained = t + 0.26 * Math.sin(Math.PI * t) * (1 - t * 0.25);
    return gained < 1 ? gained : 1;
}

/* ------------------------------------------------------------ 핵심 변환 */

/**
 * CMYK(각 0~1) → sRGB(각 0~255).
 * CMY는 8꼭짓점 삼선형 보간, K는 감쇠 곱.
 *
 * 실제 ICC LUT 변환으로 교체하려면 이 함수만 바꾸면 된다.
 */
export function computeJapanColorRGB(c, m, y, k) {
    // 도트 게인 반영
    const C = applyDotGain(c);
    const M = applyDotGain(m);
    const Y = applyDotGain(y);
    const K = applyDotGain(k);

    // CMY 삼선형 보간 — 8개 꼭짓점의 가중 평균
    const w = CORNER_RGB.white;
    const wC = CORNER_RGB.c, wM = CORNER_RGB.m, wY = CORNER_RGB.y;
    const wCM = CORNER_RGB.cm, wCY = CORNER_RGB.cy, wMY = CORNER_RGB.my;
    const wCMY = CORNER_RGB.cmy;

    const iC = 1 - C, iM = 1 - M, iY = 1 - Y;

    // 각 꼭짓점의 기여 가중치 (합 = 1)
    const g000 = iC * iM * iY;   // 백지
    const g100 = C * iM * iY;   // C
    const g010 = iC * M * iY;   // M
    const g001 = iC * iM * Y;   // Y
    const g110 = C * M * iY;   // C+M
    const g101 = C * iM * Y;   // C+Y
    const g011 = iC * M * Y;   // M+Y
    const g111 = C * M * Y;   // C+M+Y

    let r = g000 * w.r + g100 * wC.r + g010 * wM.r + g001 * wY.r +
        g110 * wCM.r + g101 * wCY.r + g011 * wMY.r + g111 * wCMY.r;
    let g = g000 * w.g + g100 * wC.g + g010 * wM.g + g001 * wY.g +
        g110 * wCM.g + g101 * wCY.g + g011 * wMY.g + g111 * wCMY.g;
    let b = g000 * w.b + g100 * wC.b + g010 * wM.b + g001 * wY.b +
        g110 * wCM.b + g101 * wCY.b + g011 * wMY.b + g111 * wCMY.b;

    // K 적용 — 선형 감쇠. 기준화로 백지가 1이라 K_SOLID_RGB가 곧 감쇠 비율이다.
    if (K > 0) {
        r *= (1 - K) + K * K_SOLID_RGB.r;
        g *= (1 - K) + K * K_SOLID_RGB.g;
        b *= (1 - K) + K * K_SOLID_RGB.b;
    }

    // 선형 → sRGB 감마 → 8bit
    return {
        r: Math.round(encodeGamma(r) * 255),
        g: Math.round(encodeGamma(g) * 255),
        b: Math.round(encodeGamma(b) * 255)
    };
}

/* ------------------------------------------------------------ 룩업 테이블 */

/**
 * 런타임 구조는 정확도보다 픽셀당 비용에 맞춰 설계했다.
 *
 * 처음에는 CMYK 4차원 격자에 사선 보간(16점)을 썼는데, Chrome에서 870만 픽셀에
 * 1600ms가 나왔다(같은 코드가 Node에서는 300ms — JIT 차이라 Node 수치는 믿을 수 없다).
 * 격자 크기를 9~33으로 바꿔도 671~719ms로 거의 그대로여서 병목은 메모리가 아니라
 * 픽셀당 보간 연산량이었다.
 *
 * 그래서 K를 곱셈으로 분리했다. 이 모델에서 K는 백지 대비 감쇠 계수라
 * 분리해도 최대 오차가 7/255 수준이다. 결과적으로:
 *   - CMY는 3차원 격자 + C축만 선형 보간
 *   - K는 256단계 감쇠 커브를 곱셈 한 번
 *   - 0~255 → 격자 오프셋 변환은 256칸 정수 표로 미리 계산(픽셀당 나눗셈 제거)
 * 픽셀당 조회 몇 번과 곱셈 3번으로 줄어 870만 픽셀 323ms. 같은 조건에서 측정한
 * 기존 순수 반전이 196ms이므로 약 1.6배이며, 실제 화면 렌더에서는 체감되지 않는다.
 */

// CMY 격자 단계. 64면 64^3 × 3 × 4바이트(Float32) = 3MB.
const GRID = 64;
const GRID_MAX = GRID - 1;

const STRIDE_C = GRID * GRID * 3;
const STRIDE_M = GRID * 3;

let _cmyTable = null;   // K=0일 때의 CMY → RGB
let _kCurve = null;     // K 감쇠 계수 (백지 대비 비율), 256단계
let _idxC = null;       // 0-255 → CMY 테이블 C축 오프셋 (하위 격자점)
let _idxCT = null;      // 0-255 → C축 보간 계수
let _idxM = null;
let _idxY = null;

function buildTables() {
    // 1) K=0 평면의 CMY → RGB
    const cmy = new Float32Array(GRID * GRID * GRID * 3);
    let idx = 0;
    for (let ci = 0; ci < GRID; ci++) {
        const c = ci / GRID_MAX;
        for (let mi = 0; mi < GRID; mi++) {
            const m = mi / GRID_MAX;
            for (let yi = 0; yi < GRID; yi++) {
                const rgb = computeJapanColorRGB(c, m, yi / GRID_MAX, 0);
                cmy[idx++] = rgb.r;
                cmy[idx++] = rgb.g;
                cmy[idx++] = rgb.b;
            }
        }
    }

    // 2) K 감쇠 커브 — 백지 대비 비율이라 CMY 결과에 그대로 곱하면 된다
    const white = computeJapanColorRGB(0, 0, 0, 0);
    const kc = new Float32Array(256 * 3);
    for (let k = 0; k < 256; k++) {
        const rgb = computeJapanColorRGB(0, 0, 0, k / 255);
        kc[k * 3] = rgb.r / white.r;
        kc[k * 3 + 1] = rgb.g / white.g;
        kc[k * 3 + 2] = rgb.b / white.b;
    }

    // 3) 0-255 → 격자 오프셋 (픽셀 루프에서 나눗셈·반올림을 없애기 위함)
    const iC = new Int32Array(256), iCT = new Float32Array(256);
    const iM = new Int32Array(256), iY = new Int32Array(256);
    for (let v = 0; v < 256; v++) {
        // C축만 보간 — 오차가 가장 큰 축이라 여기에만 비용을 쓴다
        const f = (v / 255) * GRID_MAX;
        const lo = f < GRID_MAX ? Math.floor(f) : GRID_MAX - 1;
        iC[v] = lo * STRIDE_C;
        iCT[v] = f - lo;

        iM[v] = Math.round((v / 255) * GRID_MAX) * STRIDE_M;
        iY[v] = Math.round((v / 255) * GRID_MAX) * 3;
    }

    _cmyTable = cmy;
    _kCurve = kc;
    _idxC = iC; _idxCT = iCT; _idxM = iM; _idxY = iY;
}

/** 테이블을 미리 만들어 첫 렌더에서 끊기지 않게 한다 (약 100ms). */
export function warmUpColorProfile() {
    if (!_cmyTable) buildTables();
}

// 0-255 정수로 강제. 인덱스 표는 정수 첨자만 받으므로 소수나 범위 밖 값이 들어오면
// 조회 결과가 undefined가 되어 NaN이 전파된다(평균 잉크량처럼 소수가 자연스럽게 나오는
// 호출부가 있어 방어가 필요하다).
function clamp255(v) {
    return v > 0 ? (v < 255 ? (v + 0.5) | 0 : 255) : 0;
}

/**
 * 픽셀 루프용 변환. CMYK(각 0~255) → out[offset..offset+2]에 sRGB(0~255).
 * out은 Uint8ClampedArray여도 되고(자동 반올림·클램프), Float32Array여도 된다.
 *
 * 입력이 이미 0-255 정수임이 확실한 대량 루프에서는 이 함수 대신
 * getColorTables()로 테이블을 받아 직접 인라인하는 편이 빠르다.
 */
export function cmykToRGBInto(c, m, y, k, out, offset) {
    if (!_cmyTable) buildTables();

    const ci = clamp255(c), mi = clamp255(m), yi = clamp255(y), ki = clamp255(k);

    const T = _cmyTable;
    const base = _idxC[ci] + _idxM[mi] + _idxY[yi];
    const ct = _idxCT[ci];
    const hi = base + STRIDE_C;
    const ko = ki * 3;

    // C축 선형 보간 후 K 감쇠 곱
    out[offset] = (T[base] + (T[hi] - T[base]) * ct) * _kCurve[ko];
    out[offset + 1] = (T[base + 1] + (T[hi + 1] - T[base + 1]) * ct) * _kCurve[ko + 1];
    out[offset + 2] = (T[base + 2] + (T[hi + 2] - T[base + 2]) * ct) * _kCurve[ko + 2];
}

// 단발성 조회용 래퍼 (별색 표시색 추정 등, 픽셀 루프가 아닌 곳).
// 평균값처럼 소수가 들어와도 되도록 cmykToRGBInto가 정수로 맞춰 준다.
const _scratch = new Float32Array(3);
export function cmykToRGB255(c, m, y, k) {
    cmykToRGBInto(c, m, y, k, _scratch, 0);
    return { r: _scratch[0], g: _scratch[1], b: _scratch[2] };
}

/**
 * 대량 픽셀 루프에서 변환을 인라인하기 위한 테이블 직접 접근.
 * 픽셀당 함수 호출이 전체 비용의 상당 부분이라(870만 픽셀 기준 763ms → 312ms),
 * 렌더 루프에서는 이 테이블을 지역 변수로 받아 직접 조회한다.
 * 사용법은 cmykToRGBInto 본문과 동일하다.
 *
 * 주의: 인덱스 표(idxC/idxM/idxY)는 0-255 "정수" 첨자만 받는다.
 * 소수가 섞일 수 있는 값(별색 감산 결과 등)은 `| 0`으로 내림한 뒤 넘길 것.
 * 소수를 그대로 넣으면 undefined가 조회되어 NaN이 화면에 퍼진다.
 */
export function getColorTables() {
    if (!_cmyTable) buildTables();
    return {
        cmy: _cmyTable,
        kCurve: _kCurve,
        idxC: _idxC,
        idxCT: _idxCT,
        idxM: _idxM,
        idxY: _idxY,
        STRIDE_C
    };
}
