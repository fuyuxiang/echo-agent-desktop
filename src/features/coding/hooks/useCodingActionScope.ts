import { useCallback, useEffect, useMemo } from "react";

/** A completed operation may update only the task/view where it was started. */
export function useCodingActionScope(root: string, taskId?: string | null, detail = "") {
  const scope = useMemo(() => ({ active: true }), [root, taskId, detail]);
  useEffect(() => {
    scope.active = true;
    return () => { scope.active = false; };
  }, [scope]);
  return useCallback(() => scope.active, [scope]);
}
