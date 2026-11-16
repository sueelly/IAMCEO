declare module "*.md" {
  const text: string;
  export default text;
}

// 파일로 싣는 도식 부품(server/vendor-mermaid.ts): import 한 값은 그 파일의 자리(경로)다.
declare module "mermaid/dist/mermaid.min.js" {
  const path: string;
  export default path;
}
