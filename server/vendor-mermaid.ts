// 도식(Mermaid) 그리는 부품 파일의 자리. 정적 import 를 이 모듈에 가둔다: 컴파일한 실행 파일에도 파일이 들어가고(type: "file"),
// 패키지가 없는 곳에서도 서버가 뜬다(http.ts 가 이 모듈을 동적 import 한다. web-index.ts 와 같은 방식).
import file from "mermaid/dist/mermaid.min.js" with { type: "file" };

export default file;
