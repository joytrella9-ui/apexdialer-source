export type TalkLine = { line: string; why: string };

const RULES: Array<{ test: RegExp; line: string; why: string }> = [
  {
    test: /not interested|no thanks|not a good fit/,
    line: "Totally fair. Before I let you go, was it the timing, or is this just not useful?",
    why: "One honest question. Do not pile on a second pitch.",
  },
  {
    test: /email|send (me )?(info|something)/,
    line: "I can send a short note. What should it answer so it is worth opening?",
    why: "An email with no question usually dies. Get the real objection.",
  },
  {
    test: /expensive|too much|budget|price|cost/,
    line: "Price only matters against what it replaces. What does this cost you in time today?",
    why: "Do not invent a discount. This desk has no price list.",
  },
  {
    test: /bad time|busy|in a meeting|call (me )?later|not a good time/,
    line: "I'll get off the line. What day and time should I call, and is this the best number?",
    why: "Put that time in the follow-up field before you save.",
  },
  {
    test: /who (is|are) (this|you)|how did you get|where did you get my number/,
    line: "This is a work call. I can tell you how we have this number. If that is not okay, I will take you off the list.",
    why: "Be specific. If they want off, mark do-not-call. Do not invent a lead source.",
  },
  {
    test: /already (have|use|working with)|vendor|provider/,
    line: "Most people I talk to already have someone. What would have to be true for ten more minutes to be worth it?",
    why: "Do not attack their current vendor. Ask for the gap.",
  },
];

export function replyToObjection(text: string): TalkLine {
  const trimmed = text.trim();
  const hit = RULES.find((rule) => rule.test.test(trimmed));
  if (hit) return { line: hit.line, why: hit.why };
  if (!trimmed) return { line: "Ask what they mean, then stop talking.", why: "A blank objection is not a cue to pitch." };
  return {
    line: "I hear you. Say that back in one sentence, then ask what would make this worth continuing.",
    why: "Nothing canned matched. Do not invent a fact, price, or promise.",
  };
}
