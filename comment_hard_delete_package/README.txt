질문 및 토론 게시판 댓글 완전 삭제 패치

포함 파일
- index.html: 댓글 삭제 시 Firestore 문서를 완전 삭제하고, 삭제된 댓글 문구를 표시하지 않도록 수정
- admin.js: 기존 deleted:true 댓글을 일괄 정리하는 명령 추가
- firestore.rules: 기존 삭제 권한은 유지하고 설명 주석만 수정

적용 방법
1. 기존 index.html을 백업한 뒤 이 패키지의 index.html로 교체하여 배포합니다.
2. 기존에 삭제된 댓글 문서까지 정리하려면 admin.js가 있는 폴더에서 다음을 실행합니다.
   node admin.js purge-deleted-comments
3. 실행 전 해당 Firebase 프로젝트의 Firestore 데이터를 백업하는 것을 권장합니다.

관리자 스크립트 실행 준비
- 같은 폴더에 serviceAccount.json을 직접 준비합니다.
- npm install firebase-admin
- serviceAccount.json은 보안상 이 ZIP에 포함하지 않았으며 GitHub 등에 올리지 마세요.

주의
- Firestore rules는 작성자 본인의 댓글 삭제만 허용합니다.
- 상위 댓글을 삭제해도 살아 있는 답글은 보존되며, 게시판에서 독립 댓글처럼 표시됩니다.
- deleted:true로 남아 있던 문서는 화면에서 숨겨지고, 위 정리 명령으로 실제 삭제할 수 있습니다.
