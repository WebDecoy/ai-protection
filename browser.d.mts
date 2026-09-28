/** Refresh the installed browser tag's short-lived evidence; never blocks on failure. */
export function prepareBrowserEvidence(options?:{timeoutMs?:number}):Promise<{available:boolean}>;
