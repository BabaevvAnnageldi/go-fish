// Guest-seat policy for the host (pure, so it can be unit-tested without the DOM).

export const MAX_CLIENT_ID = 40;

export const seatId = (hello) => (typeof hello?.clientId === 'string' ? hello.clientId.slice(0, MAX_CLIENT_ID) : null);

// Once a guest's clientId is recorded, only that client may take the seat, even while it is
// disconnected; a stranger can never take over a game in progress.
export function canSeat(guestId, hello) {
  return !guestId || seatId(hello) === guestId;
}
