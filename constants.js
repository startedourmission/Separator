// 팬톤 RGB 근사값 매핑 (주요 색상만)
export const PANTONE_RGB_MAP = {
    'PANTONE 186 C': { r: 200, g: 16, b: 46 },    // 빨강
    'PANTONE 287 C': { r: 0, g: 51, b: 160 },     // 파랑
    'PANTONE 354 C': { r: 0, g: 135, b: 81 },     // 초록
    'PANTONE 021 C': { r: 254, g: 80, b: 0 },     // 오렌지
    'PANTONE 2925 C': { r: 0, g: 159, b: 227 },   // 하늘색
    'PANTONE 7737 C': { r: 209, g: 0, b: 116 },   // 마젠타
    'PANTONE 109 C': { r: 255, g: 214, b: 0 },    // 노랑
    'PANTONE Cool Gray 11 C': { r: 83, g: 86, b: 90 },  // 회색
    'PANTONE 485 C': { r: 218, g: 41, b: 28 },    // 밝은 빨강
    'PANTONE 300 C': { r: 0, g: 87, b: 184 }      // 진한 파랑
};

// 팬톤 색상의 RGB 근사값 조회
export function getSpotColorRGB(colorName) {
    // 매핑 테이블에서 조회
    if (PANTONE_RGB_MAP[colorName]) {
        return PANTONE_RGB_MAP[colorName];
    }

    // 매핑되지 않은 색상은 기본 회색으로 표시
    console.warn(`팬톤 색상 "${colorName}"의 RGB 근사값이 없습니다. 기본 회색으로 표시합니다.`);
    return { r: 128, g: 128, b: 128 };
}
