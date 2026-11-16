// 본문의 도식(Mermaid) 블록. 그림으로 그리고, 원문도 볼 수 있다. 그리지 못하면 원문을 글로 보인다.
// 그림은 <img> 로만 보인다(web/src/lib/mermaid.ts 의 안전 설명). 도식의 글은 글자로만 다루고 HTML 로 해석하지 않는다.
import { useEffect, useState } from "react";
import { renderDiagram } from "../../lib/mermaid";

export function MermaidBlock({ code }: { code: string }) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let made: string | null = null;
    setImage(null);
    setError(null);
    if (!code.trim()) {
      setError("도식 글이 비어 있습니다");
      return;
    }
    renderDiagram(code).then(
      (d) => {
        if (stopped) return;
        made = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
        setImage({ url: made, width: d.width, height: d.height });
      },
      (e) => !stopped && setError((e instanceof Error && e.message ? e.message : "알 수 없는 까닭").split("\n")[0]!.slice(0, 200)),
    );
    return () => {
      stopped = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [code, attempt]);
  const drawn = image !== null && !source;
  return (
    <figure className="aar-diagram" data-state={image ? "drawn" : error ? "failed" : "drawing"}>
      <figcaption className="aar-diagram__cap">
        <span>{drawn ? "도식" : "도식 원문"}</span>
        {image ? <button type="button" className="aa-link" onClick={() => setSource((v) => !v)}>{source ? "그림 보기" : "원문 보기"}</button> : null}
        {error ? <button type="button" className="aa-link" onClick={() => setAttempt((n) => n + 1)}>다시 그리기</button> : null}
      </figcaption>
      {drawn ? <img className="aar-diagram__img" src={image.url} width={image.width} height={image.height} alt="도식" draggable={false} /> : <pre className="aar-diagram__code">{code}</pre>}
      {error ? <p className="aar-note" role="status">도식을 그리지 못해 원문을 보입니다: {error}</p> : !image ? <p className="aar-note" role="status">도식을 그리는 중…</p> : null}
    </figure>
  );
}
