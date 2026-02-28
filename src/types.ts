export const STATUS_KEY = "pi-jj";
export const CHECKPOINT_ENTRY_TYPE = "jj-checkpoint";
export const DEFAULT_MAX_CHECKPOINTS = 200;
export const DEFAULT_CHECKPOINT_LIST_LIMIT = 30;

export type Checkpoint = {
  entryId: string;
  revision: string;
  timestamp: number;
};

export type PendingCheckpoint = {
  revision: string;
  timestamp: number;
};

export type PiJjSettings = {
  silentCheckpoints: boolean;
  maxCheckpoints: number;
  checkpointListLimit: number;
  promptForInit: boolean;
};

export const DEFAULT_SETTINGS: PiJjSettings = {
  silentCheckpoints: false,
  maxCheckpoints: DEFAULT_MAX_CHECKPOINTS,
  checkpointListLimit: DEFAULT_CHECKPOINT_LIST_LIMIT,
  promptForInit: true,
};
