# Toynbee PDF Viewer

인쇄용 PDF 및 이미지 파일을 분석하고 편집하기 위한 웹 기반 도구입니다. 모든 처리는 브라우저상에서 로컬로 진행됩니다.

## 주요 기능

- **CMYK 분판 분석**: C, M, Y, K 각 채널별 온/오프 및 별색(Spot Color) 감지
- **잉크량 분석**: 마우스 위치의 실시간 TAC(Total Area Coverage) 및 채널별 비율 표시
- **표지 계산기**: 판형 정보를 바탕으로 책등, 날개, 펼침면 크기 자동 계산
- **분석 도구**: 드래그 영역의 텍스트 스캔(OCR) 및 바코드/QR 분석
- **워터마크**: 다수의 텍스트를 일괄 적용한 개별 PDF 및 압축 파일 생성
- **고해상도 렌더링**: 최대 1200 DPI 수준의 정밀한 렌더링 지원

## 실행 방법

1. 의존성 설치:
   ```bash
   npm install
   ```
2. 로컬 서버 실행:
   ```bash
   npm start
   ```
3. 웹 브라우저에서 `localhost:5000` (또는 지정된 포트) 접속

## 기술 사양

- **Core**: WebAssembly 기반 Ghostscript (분판 렌더링)
- **PDF**: pdf.js (뷰어), pdf-lib (워터마크 수정)
- **Processing**: Tesseract.js (OCR), ZXing (Barcode/QR)
- **Performance**: Virtual Scrolling 기반 대용량 PDF 처리

