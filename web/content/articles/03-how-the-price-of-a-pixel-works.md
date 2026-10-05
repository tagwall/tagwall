# how the price of a pixel works

**subtitle:** +10% to take a square, 90 days frozen, then decay back toward the floor
**read time:** 4 min
**series:** building tagwall, part 3 of 5

---

I can't change any of the numbers in this article. They're written into the contract, and there's no admin setting or vote that can move them. So when I picked them I wasn't trying to get this year right. I wanted numbers that would still make sense in ten years, whatever happens to the chains.

## what a pixel costs

An empty pixel costs a few cents. Each chain got its own starting price on launch day, somewhere around five US cents in that chain's coin.

If someone has already painted it, you pay ten percent more than they did. Nobody sets the price of a good spot. It builds up as people take it from each other, because each person pays ten percent over the last price, not over the starting one. Five cents becomes five and a half, then a bit over six. Ten takeovers in, it's around thirteen cents.

You only pay for the pixels you actually paint, so if your logo is round, the corners aren't charged. You also set a maximum when you paint. If someone grabs the spot while your transaction is going through, yours fails instead of charging you more.

## what happens after you paint

For 90 days your price doesn't move. Anyone who wants the square pays what you paid plus ten percent.

After that, the price starts drifting back down to the starting price and gets there ten months later. Paint a square at fifteen cents on a five cent start and, once the 90 days are up, it drops about a cent a month until it's back to five.

That wasn't in my first design. Prices only went up. Then I thought about what that looks like after a few years. A project paints a great spot, the project dies, and the spot stays expensive forever. Ten years on, the middle of the wall is dead links nobody can afford to paint over.

With the price drifting down, a spot nobody cares about anymore slowly gets cheap again. If people still want it, someone paints over it and the price keeps climbing.

## paying extra to keep a spot

There's one setting you get to play with. When you paint, you can choose to pay more than the minimum, up to 100 times more, and the wall treats that as your price.

That makes your spot harder to take, because the next person has to pay ten percent over what you actually paid. Pay ten times over on a five cent pixel and they need about fifty-five cents. Your price also drifts down from that higher number, so the spot stays expensive to take for longer. It's the only way to tell the wall you really want to keep something.

## why ten percent

Ten percent was the number I was least sure about, so before launching I ran a simulation. It filled a pretend wall with painters on different budgets, from people leaving a small tag to projects defending a patch, and ran it over and over with their behaviour shuffled. I tried takeover fees from 5% up to 50%.

A lower fee meant more people painting. The money coming in hardly changed. Across the whole range, two years of income landed within about 2%, because a higher fee earns more per paint and gets fewer paints. Money couldn't decide it for me, so I could pick on how busy the wall stays.

On that measure 5% came out a little ahead of the 10% I went with. I kept 10% because anyone can work it out in their head, and the gap was small enough that I didn't want to reopen a decision I'd already made. I also tried faster and slower drop-offs after the 90 days, and they made almost no difference.

## the one i can't fix

The starting price is set in each chain's own coin, not in dollars. It was about five cents on launch day and it doesn't follow the coin after that. If the coin goes up ten times, an empty pixel costs fifty cents. At a hundred times it's five dollars.

The contract can't adjust for that. To follow the dollar price it would need someone outside telling it what the coin is worth, and whoever that is could get it wrong or go offline. I didn't want the wall relying on anyone, so I left it out. If a coin ever runs that far, the fix is a new wall with a new starting price, and the old one carries on working exactly as it does now.

---
