import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CriticalConfirmationDecision,
  CriticalConfirmationPrompt,
} from "../shared/critical-confirmation";
import type { WorldlineBoxShellApi } from "../shared/external-url";

export function useCriticalConfirmationPrompt(
  shell: WorldlineBoxShellApi | undefined,
): {
  request: CriticalConfirmationPrompt | null;
  decide: (decision: CriticalConfirmationDecision) => void;
} {
  const [request, setRequest] = useState<CriticalConfirmationPrompt | null>(null);
  const submittedId = useRef<string | null>(null);

  useEffect(() => {
    if (!shell) return;
    return shell.onCriticalConfirmationPrompt((payload) => {
      submittedId.current = null;
      setRequest(payload);
    });
  }, [shell]);

  const decide = useCallback((decision: CriticalConfirmationDecision) => {
    if (!request || !shell || submittedId.current === request.requestId) return;
    submittedId.current = request.requestId;
    setRequest(null);
    void shell.respondCriticalConfirmation(request.requestId, decision);
  }, [request, shell]);

  return { request, decide };
}
