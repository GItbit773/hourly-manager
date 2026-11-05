// Everything the manager says, by tone. {range} {n} {name} {late} get filled in.
export const TONES = {
  gentle: 'Mildly concerned',
  micro: 'Micromanager',
  drill: 'Drill sergeant',
};

export const LINES = {
  gentle: {
    prompt: ["Hi! Quick check-in: what did you get done {range}?", "Hey, how did {range} go?", "Just touching base — what happened {range}?"],
    nag: ["Still waiting on that update, no rush… but also some rush.", "Hello? Just want to know how {range} went.", "I'm getting a little worried. Update please?"],
    great: ["Wonderful, really. Keep that going.", "That's a strong hour. Proud of you.", "Love to see it."],
    meh: ["Okay, that's okay. Next hour can be better.", "Fair enough. Let's tighten up a little.", "Noted. Steady progress counts."],
    bad: ["That happens. What's one thing you can finish next hour?", "Rough hour. Let's reset — pick one small task.", "Okay. No judgement. But let's not make it a habit."],
    short: ["Could you tell me a bit more next time?", "That's… brief. A little more detail helps me help you."],
    writeoff: ["Okay, I'll mark that hour as unaccounted. Let's do better.", "Noted as a gap. It happens."],
    snooze: ["Sure, 10 more minutes.", "Okay, I'll come back shortly."],
    standup: ["Good morning! What are your top priorities today?"],
    standupSkip: ["No priorities? Okay… we'll wing it, I guess."],
    idle: ["Next check-in at {next}. You've got this.", "I'll check in at {next}. Focus on one thing."],
    owed: ["You have {n} check-ins waiting. Let's catch up."],
    breakStart: ["Enjoy your break! Back by {next}?"],
    clockOut: ["Thanks for today. Here's your summary."],
    off: ["Not a workday. Rest up."],
    before: ["Workday starts at {start}. See you then."],
    review: { A: "Outstanding day. Truly.", B: "Solid day. A few soft spots.", C: "An okay day. Room to grow.", D: "Not your best. Tomorrow's a fresh start.", F: "Rough one. Let's talk tomorrow — gently." },
  },
  micro: {
    prompt: ["It's that time. What did you do {range}? Be specific.", "Status update, {range}. Go.", "Quick sync! What got DONE {range}?", "Per our hourly alignment: what happened {range}?"],
    nag: ["I sent you a check-in. I can see you haven't opened it.", "Circling back on my previous check-in.", "Just bumping this to the top of your inbox.", "Per my last message: what did you do {range}?"],
    great: ["Good. Now do that again. Every hour.", "Great hour. I'll be expecting this level from now on.", "Excellent. Don't let it go to your head."],
    meh: ["\"Fine\" is not a deliverable.", "Mediocre. Let's take this offline. By offline I mean next hour.", "I'll allow it. This time."],
    bad: ["I'm going to need you to do better. Hourly.", "Let's put a pin in whatever that was.", "That's a lot of hour for not a lot of work."],
    short: ["That's it? I'll need more detail. Bullet points, ideally.", "One line for a whole hour? Interesting."],
    writeoff: ["An entire hour. Unaccounted. I'm noting this.", "Gone. Just like that. It's in the report."],
    snooze: ["Snoozing your manager. Bold. 10 minutes.", "Fine. 10 minutes. I'm setting a timer. I'm always setting a timer."],
    standup: ["Morning stand-up. Your top 3 priorities. Now, please."],
    standupSkip: ["No priorities? So we're just… vibing today?"],
    idle: ["Next check-in at {next}. I'll be watching.", "I want an update at {next}. Sharp.", "Clock's ticking. See you at {next}."],
    owed: ["You owe me {n} check-ins. I've been keeping count."],
    breakStart: ["A break. Sure. Back at {next}. Not {next} and one minute."],
    clockOut: ["Clocking out. Let's look at your numbers."],
    off: ["Day off. I'll pretend I'm not counting the hours."],
    before: ["You start at {start}. I'll know if you're late."],
    review: { A: "Acceptable. Very acceptable. Don't get comfortable.", B: "Decent. I've seen better. From you, actually.", C: "Average. I'm putting time on your calendar to discuss.", D: "We need to talk about your hourly output.", F: "I've scheduled a 1:1. It's at 8am. Don't be late." },
  },
  drill: {
    prompt: ["REPORT! WHAT DID YOU ACCOMPLISH {range}?", "ON YOUR FEET! WHAT DID YOU DO {range}?!", "HOURLY INSPECTION! STATE YOUR PROGRESS!"],
    nag: ["I DID NOT HEAR A REPORT!", "ARE YOU HIDING FROM ME?! REPORT IN!", "EVERY MINUTE YOU DON'T ANSWER IS ANOTHER LAP!"],
    great: ["OUTSTANDING! NOW DO IT AGAIN!", "THAT'S WHAT I LIKE TO SEE! DON'T STOP!", "FINALLY! A REAL HOUR OF WORK!"],
    meh: ["MEDIOCRITY IS NOT A STRATEGY!", "I'VE SEEN MORE HUSTLE FROM A HOUSEPLANT!", "PICK UP THE PACE!"],
    bad: ["UNACCEPTABLE! DROP AND GIVE ME A FINISHED TASK!", "WHAT WAS THAT?! NEXT HOUR, REDEMPTION!", "MY GRANDMOTHER WORKS FASTER!"],
    short: ["THAT'S NOT A REPORT, THAT'S A WHISPER!", "MORE DETAIL! I WANT NUMBERS!"],
    writeoff: ["AN HOUR LOST IN ACTION! IT GOES ON YOUR RECORD!", "DESERTER! THAT HOUR IS MARKED!"],
    snooze: ["SNOOZE?! TEN MINUTES! NOT ONE SECOND MORE!"],
    standup: ["MORNING FORMATION! STATE YOUR TOP 3 OBJECTIVES!"],
    standupSkip: ["NO OBJECTIVES?! YOU'RE MARCHING BLIND!"],
    idle: ["NEXT INSPECTION AT {next}! GET MOVING!", "{next}! BE READY!"],
    owed: ["YOU OWE ME {n} REPORTS! START TALKING!"],
    breakStart: ["BREAK GRANTED! BACK AT {next} SHARP!"],
    clockOut: ["DISMISSED! HERE'S YOUR EVALUATION!"],
    off: ["AT EASE. REST TODAY. TRAIN TOMORROW."],
    before: ["REVEILLE IS AT {start}! BE READY!"],
    review: { A: "EXEMPLARY SERVICE! YOU MAY REST!", B: "GOOD WORK! NOT GREAT! GOOD!", C: "PASSABLE! BARELY!", D: "YOU CALL THAT A DAY?!", F: "I WANT YOU AT FORMATION AT 0600!" },
  },
};

export function say(tone, key, vars = {}) {
  const set = LINES[tone] || LINES.micro;
  let v = set[key];
  if (Array.isArray(v)) v = v[Math.floor(Math.random() * v.length)];
  return String(v).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
