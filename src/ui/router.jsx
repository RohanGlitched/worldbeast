import { useEffect, useState } from "react";

// A tiny pushState router: the whole game is one page app; links turn the codex's pages.

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener("popstate", f);
    window.addEventListener("wb:navigate", f);
    return () => {
      window.removeEventListener("popstate", f);
      window.removeEventListener("wb:navigate", f);
    };
  }, []);
  return path;
}

export function navigate(to) {
  if (to === location.pathname + location.search) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new Event("wb:navigate"));
  window.scrollTo(0, 0);
}

export function Link({ to, children, ...rest }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
