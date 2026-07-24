// 팬톤 RGB 근사값 매핑
export const PANTONE_RGB_MAP = {
    // 기본 색상
    'PANTONE 186 C': { r: 200, g: 16, b: 46 },    // 빨강
    'PANTONE 287 C': { r: 0, g: 51, b: 160 },     // 파랑
    'PANTONE 354 C': { r: 0, g: 135, b: 81 },     // 초록
    'PANTONE 021 C': { r: 254, g: 80, b: 0 },     // 오렌지
    'PANTONE 2925 C': { r: 0, g: 159, b: 227 },   // 하늘색
    'PANTONE 7737 C': { r: 209, g: 0, b: 116 },   // 마젠타
    'PANTONE 109 C': { r: 255, g: 214, b: 0 },    // 노랑
    'PANTONE Cool Gray 11 C': { r: 83, g: 86, b: 90 },  // 회색
    'PANTONE 485 C': { r: 218, g: 41, b: 28 },    // 밝은 빨강
    'PANTONE 300 C': { r: 0, g: 87, b: 184 },     // 진한 파랑

    // 내지 별색
    'PANTONE 3405 U': { r: 0, g: 178, b: 122 },   // 초록 (스프링 부트 3)
    'PANTONE 3405 C': { r: 0, g: 175, b: 117 },
    'PANTONE 2193 C': { r: 0, g: 127, b: 201 },   // 파랑 (바이브코딩)
    'PANTONE 2193C': { r: 0, g: 127, b: 201 },
    'PANTONE 192 C': { r: 224, g: 60, b: 82 },    // 빨강 (바이브코딩 커서 AI)
    'PANTONE 192C': { r: 224, g: 60, b: 82 },
    'PANTONE Green U': { r: 0, g: 171, b: 132 },  // 초록 (바이브코딩 v0+커서)
    'PANTONE Green C': { r: 0, g: 169, b: 130 },
    'PANTONE Orange 021 C': { r: 254, g: 80, b: 0 },  // 오렌지 (요즘 당근 AI)
    'PANTONE Orange 021 U': { r: 248, g: 108, b: 36 },
    'PANTONE 7710 C': { r: 0, g: 155, b: 145 },   // 청록 (요즘 우아한 AI)
    'PANTONE 7710C': { r: 0, g: 155, b: 145 },
    'PANTONE 3252 C': { r: 42, g: 210, b: 194 },  // 민트 (요즘 우아한 개발)
    'PANTONE 3252C': { r: 42, g: 210, b: 194 },
    'PANTONE 266 C': { r: 109, g: 32, b: 119 },   // 보라 (구글 클래스룸)
    'PANTONE 266 U': { r: 127, g: 63, b: 152 },
    'PANTONE 2420 C': { r: 147, g: 55, b: 143 },  // 보라 (슈퍼유튜브시트)
    'PANTONE 2420C': { r: 147, g: 55, b: 143 },
    'PANTONE 7481 C': { r: 0, g: 175, b: 102 },   // 초록 (슈퍼유튜브시트)
    'PANTONE 7481C': { r: 0, g: 175, b: 102 },

    // 표지 별색 (5도)
    'PANTONE 2191 C': { r: 0, g: 144, b: 218 },   // 파랑 (리액트)
    'PANTONE 2191C': { r: 0, g: 144, b: 218 },
    'PANTONE 806 U': { r: 255, g: 0, b: 147 },    // 형광 핑크 (파이썬 데이터 분석가)
    'PANTONE 806 C': { r: 255, g: 0, b: 144 },
    'PANTONE 806C': { r: 255, g: 0, b: 144 },
    'PANTONE 806U': { r: 255, g: 0, b: 147 },

    // 시리즈 기본 별색
    'PANTONE 146 C': { r: 179, g: 127, b: 31 },   // 금색 (MUST HAVE / 원칙)
    'PANTONE 146C': { r: 179, g: 127, b: 31 },

    // 추가 팬톤 색상
    'PANTONE 285 C': { r: 0, g: 114, b: 198 },     // 파랑
    'PANTONE 285C': { r: 0, g: 114, b: 198 },
    'PANTONE 717 C': { r: 227, g: 120, b: 18 },    // 오렌지
    'PANTONE 717C': { r: 227, g: 120, b: 18 },
    'PANTONE 2228 C': { r: 0, g: 130, b: 100 },    // 청록
    'PANTONE 2228C': { r: 0, g: 130, b: 100 },
    'PANTONE 2925 C': { r: 0, g: 159, b: 227 },    // 하늘색 (중복이지만 명시)
    'PANTONE 3534 C': { r: 0, g: 160, b: 175 },    // 틸
    'PANTONE 3534C': { r: 0, g: 160, b: 175 },
    'PANTONE 3538 C': { r: 0, g: 137, b: 154 },    // 어두운 틸
    'PANTONE 3538C': { r: 0, g: 137, b: 154 },
    'PANTONE 3556 C': { r: 212, g: 50, b: 88 },    // 핑크 레드
    'PANTONE 3556C': { r: 212, g: 50, b: 88 },

    // DIC 별색
    'DIC 77': { r: 255, g: 82, b: 102 },              // 핑크 레드
    'DIC 77s*': { r: 255, g: 82, b: 102 },

    // 한글 커스텀 별색 이름
    '우아한 형제들 메인 색상': { r: 0, g: 155, b: 145 }  // PANTONE 7710C 계열
};

// 사전 구축된 정규화 조회맵 (O(1) 검색)
const _normalizedMap = new Map();
const _strippedMap = new Map();
const _stripSuffix = (s) => s.replace(/\s*[CU]$/i, '').replace(/\s*[CU]$/i, '');

for (const [key, value] of Object.entries(PANTONE_RGB_MAP)) {
    const norm = key.toUpperCase().replace(/\s+/g, ' ').trim();
    _normalizedMap.set(norm, value);
    _strippedMap.set(_stripSuffix(norm), value);
}

// 조회 결과 캐시 (한번 찾은 이름은 O(1))
const _lookupCache = new Map();
const _warnedColors = new Set();
const _defaultGray = { r: 128, g: 128, b: 128 };
const _registeredColors = new Map();

/**
 * 문서 데이터에서 추정한 별색 RGB 등록.
 * 팬톤 테이블에 없는 임의 스와치 이름("변경색상" 등)도 실제 색으로 표시하기 위함.
 */
export function registerSpotColorRGB(colorName, rgb) {
    _registeredColors.set(colorName, rgb);
    _lookupCache.set(colorName, rgb);
}

// 실제 매핑(테이블 또는 문서 추정값)이 있는지 — 회색 폴백 여부 판단용
export function hasSpotColorRGB(colorName) {
    if (_registeredColors.has(colorName)) return true;
    if (PANTONE_RGB_MAP[colorName]) return true;
    const normalized = colorName.toUpperCase().replace(/\s+/g, ' ').trim();
    return _normalizedMap.has(normalized) || _strippedMap.has(_stripSuffix(normalized));
}

// 팬톤 색상의 RGB 근사값 조회
export function getSpotColorRGB(colorName) {
    // 캐시 히트
    const cached = _lookupCache.get(colorName);
    if (cached) return cached;

    // 1. 정확한 매칭
    let result = PANTONE_RGB_MAP[colorName];
    if (!result) {
        // 2. 정규화 매칭
        const normalized = colorName.toUpperCase().replace(/\s+/g, ' ').trim();
        result = _normalizedMap.get(normalized);
        if (!result) {
            // 3. 접미사 제거 매칭
            result = _strippedMap.get(_stripSuffix(normalized));
        }
    }

    if (result) {
        _lookupCache.set(colorName, result);
        return result;
    }

    if (!_warnedColors.has(colorName)) {
        _warnedColors.add(colorName);
        console.warn(`팬톤 색상 "${colorName}"의 RGB 근사값이 없습니다. 기본 회색으로 표시합니다.`);
    }
    _lookupCache.set(colorName, _defaultGray);
    return _defaultGray;
}
