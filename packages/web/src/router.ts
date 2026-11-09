import { useEffect, useState, type MouseEvent } from "react";

/** The current path, kept in step with back/forward and `navigate`. */
export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return path;
}

export function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Props for an <a> that navigates within the app instead of reloading the page. */
export function link(path: string) {
  return {
    href: path,
    onClick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(path);
    },
  };
}
