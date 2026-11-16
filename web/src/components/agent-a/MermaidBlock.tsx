// 문서의 도식(Mermaid) 블록.
// 이 화면은 아직 도식을 그림으로 그리지 않는다: Mermaid 그리기 부품을 IAMCEO 에 넣을지(의존성·용량) 정해지지 않았다.
// 그래서 도식 원문을 '도식 원문'이라고 밝혀 글로 보인다. 원문은 글자로만 넣으므로 스크립트·바깥 주소가 실행되거나 불리지 않는다.
export function MermaidBlock({ code }: { code: string }) {
  return (
    <figure className="aar-diagram" aria-label="도식 원문">
      <figcaption className="aar-diagram__cap">도식(Mermaid) 원문 · 이 화면은 아직 그림으로 그리지 않습니다</figcaption>
      <pre className="aar-diagram__code"><code>{code}</code></pre>
    </figure>
  );
}
