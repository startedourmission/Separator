// RGB 출력은 별도 시뮬레이션이 필요하고, 분판 장치는 원본 잉크판을 유지한다.
// OFF도 명시해야 Ghostscript의 기본값(enable)이 적용되지 않는다.
export function overprintArgs(enabled = true, rgbOutput = false) {
    return [`-dOverprint=/${enabled ? (rgbOutput ? 'simulate' : 'enable') : 'disable'}`];
}
