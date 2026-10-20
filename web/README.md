# web

React + three.js 화면입니다. 실행 방법은 저장소 루트의 README를 보세요.

```
npm install
npm run dev        # http://127.0.0.1:5173 (엔진 8010, 챗봇 8000 서버가 필요한 단계가 있음)
npm run build      # 타입 검사 후 빌드
```

`public/mock/`의 JSON은 `pipelines/`가 가공한 데이터입니다. 챗봇 서버 주소는 `VITE_CITE_API`로 바꿀 수 있습니다(기본 http://127.0.0.1:8000).
