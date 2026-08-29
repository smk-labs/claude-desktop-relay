# Pick the Payer once per conversation

**Superseded on 2026-08-23** by
[the unship note](../unship-holding-the-payer-for-a-conversation.md). The hold is
gone: the Payer is one value for the machine, read fresh on every request that is
swapped, and a change is in force inside conversations that are already running.
The cache saving below is real; it was smaller than the cost of a Payer you had
chosen that was not paying yet. What follows is the reasoning as it stood.

The Payer is read per request, so changing it costs nothing mechanically. It costs
plenty in tokens: prompt caching is bound to the paying organization, so switching
mid-conversation throws the cache away and the whole history is charged again. The
Payer is therefore chosen at the first request of a conversation and held.

## Consequences

One exception: a mid-conversation Refusal switches anyway, because a lost cache is
cheaper than stopped work. And "the best Seat right now" is really "the best Seat
when this conversation started", which is close enough at the rate conversations
begin.
