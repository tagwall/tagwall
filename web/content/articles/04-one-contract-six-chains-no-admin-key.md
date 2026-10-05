# one contract, six chains, no admin key

**subtitle:** what it costs to ship something you can never change
**read time:** 4 min
**series:** building tagwall, part 4 of 5

---

The tagwall contract has no owner and no admin function. Nobody can pause it or swap in new code later, and no address in it has any more power than yours.

Sourcify, a public service, recompiles a contract's published source and checks it byte for byte against what's running on the chain. tagwall is an exact match there on all six chains. If you open that source and search for "owner", "pause" or "upgrade", the only hits are in comments, and one of those is a line saying the contract has none of them.

## one address to check

Most contracts are given a few settings when they're deployed, such as who owns them and where the money goes. tagwall's doesn't get any. The treasury address and starting price for each chain are written into the code, and at deploy the contract works out which chain it's on and picks the right pair.

Because nothing is passed in, the code is identical on every chain, and identical code can be deployed to the same address. On PulseChain, Ethereum, Base and BSC the wall is at `0xd58D54ec0dBa952Efd56cE2a04DCDF1719676415`, so there's one address to publish and check across all four.

Any change to the code moves the address, which is why that's four chains and not six. Adding HyperEVM meant adding one more chain to the list, and that moved it to `0xbe682DB4c67F723Ad52a2f7Ba7Bc982C8BBDC5A4`. Robinhood Chain came later still and is at `0x280f4b7AD154109B35B550D8caBfAc98Fa02Fa4C`. The rules are the same on all six.

I wanted any mistake to show up at deploy time, while it was still cheap. If a setting is missing or wrong, or the chain isn't one the contract knows, the deploy fails and nothing is created.

## what i gave up

Whatever is in the deployed code is what the wall does for as long as the chain runs. If there's a flaw in the pricing maths, it's permanent. The only remedy is to deploy a new contract somewhere else. Nobody would be obliged to move to it, and every pixel painted into the old one stays where it is. No function can move funds, reassign a pixel or undo a transaction, including one sent by mistake.

Nothing in the contract edits or removes a paint either, including mine. That's deliberate, since a record its author can revise isn't worth much. The contract is neutral infrastructure, like the chain it runs on, so filtering happens in the viewer. The official site at tagwall.io filters content in the browser using a public list, and because all of the code is open source and can be self-hosted, anyone can audit that list.

Having no way to patch it changes how you write the code, because a bug that would cost an afternoon in most contracts is permanent here. Payments are a good example. Each paint sends 5% to the referrer, if there is one, and the rest to the treasury. Either of those can be a contract instead of a person, and a contract can be written to refuse payment. If a refused payment cancelled the paint, a bad referrer would break every paint that named it, and a treasury that refused would stop all painting for good. So neither payment is allowed to block a paint. A referral that doesn't go through is sent to the treasury instead, and the treasury payment has its own fallback.

## how it was tested

The contract has 69 tests covering painting, pricing, decay, links, the revenue split and the deploy checks.

The ones I'd recommend to anyone shipping something they can't change are the random ones. You write down rules that have to hold whatever happens, such as the price never falling below the floor and no money going missing. Then the test runner throws long random sequences of actions at the contract, looking for one that breaks a rule. It tries orders I'd never have thought to write by hand. Before launch the final contract took a million random actions against each of four rules, four million in all, and none of the rules broke.

Two AI audit passes ran before deploy. They aren't a substitute for a paid audit, but they did find real problems. The first found nothing high severity and three medium issues, and all of them were fixed. The most serious would have let a treasury that refused a payment stop all painting permanently, which is where the fallback above came from. The second pass found nothing high and one medium, in the deploy process rather than the contract.

The most useful bug came from neither. On the first PulseChain testnet deploy, one of the functions that reads from the wall failed because the chain didn't recognise an instruction. The compiler was building for the newest version of Ethereum, and PulseChain runs a slightly older one that doesn't have it. My tests couldn't catch that, because they didn't run on PulseChain. The testnet caught it on the first try, and the build now targets the older version.

---
