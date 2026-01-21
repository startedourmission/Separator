import { PDFSeparationViewer } from './PDFSeparationViewer.js';
import { SelectionManager } from './SelectionManager.js';

// 페이지 로딩 완료 시 애플리케이션 초기화
let viewer;
document.addEventListener('DOMContentLoaded', () => {
    viewer = new PDFSeparationViewer();
    // Selection Checker Add
    viewer.selectionManager = new SelectionManager(viewer);

    // 콘솔에서 viewer.testTiffsep() 호출 가능하도록 전역 변수로 노출
    window.viewer = viewer;
});
