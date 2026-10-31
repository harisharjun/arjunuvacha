// Runs the system's search off the main thread so the board never freezes.
import { chooseMove } from './ai.js';

self.onmessage = (e) => {
  const { id, state, level } = e.data;
  self.postMessage({ id, move: chooseMove(state, level) });
};
