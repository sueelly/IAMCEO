import { getCredentialGeneration } from "./api";
import { getState, useStore, type AppState } from "./store";
import type { WriteContext } from "./reviewed-writes";

function contextFromState(state: AppState): WriteContext {
  return { ...state, projectId: state.project?.project.id ?? null, credentialGeneration: getCredentialGeneration() };
}

export const readWriteContext = (): WriteContext => contextFromState(getState());
export const useWriteContext = (): WriteContext => contextFromState(useStore(state => state));
