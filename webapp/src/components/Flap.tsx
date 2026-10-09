import { useEffect, useRef, useState } from "react";

const DIGITS = "0123456789";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Split-flap departure-board text: each character spins through random glyphs before settling. */
export function Flap({ text, delay = 0, className = "" }: { text: string; delay?: number; className?: string }) {
  const [shown, setShown] = useState(() => (reduced() ? text : text.replace(/\S/g, " ")));
  const [flipping, setFlipping] = useState<boolean[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (reduced()) {
      setShown(text);
      return;
    }
    const chars = [...text];
    const state = chars.map(() => " ");
    chars.forEach((ch, i) => {
      const pool = /\d/.test(ch) ? DIGITS : /[A-Z]/.test(ch) ? LETTERS : null;
      let ticks = pool ? 5 + i * 3 : 0;
      const tick = () => {
        if (ticks-- <= 0 || !pool) {
          state[i] = ch;
        } else {
          state[i] = pool[Math.floor(Math.random() * pool.length)] ?? ch;
          timers.current.push(window.setTimeout(tick, 42));
        }
        setShown(state.join(""));
        setFlipping((f) => {
          const next = [...f];
          next[i] = !next[i];
          return next;
        });
      };
      timers.current.push(window.setTimeout(tick, delay));
    });
    return () => timers.current.forEach(clearTimeout);
  }, [text, delay]);

  return (
    <span className={`flap ${className}`} aria-label={text}>
      {[...shown].map((ch, i) => (
        <span key={`${i}-${flipping[i] ? 1 : 0}`} className="fc flip" aria-hidden="true">
          {ch}
        </span>
      ))}
    </span>
  );
}
