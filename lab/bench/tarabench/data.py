"""Built-in datasets and the loaders for outside ones.

The built-in sets are small and hand-written for this bench, so a smoke run needs nothing but the model. Real
experiments point a spec at a JSONL file, a folder of parquet files or a Hugging Face dataset instead."""
import json
import random
from pathlib import Path

NEUTRAL = [
    "The library opens at nine on weekdays and closes early on Sundays. Members can borrow up to ten books at a time, and returns can be left in the box by the front door.",
    "To make a simple tomato sauce, soften a chopped onion in olive oil, add two cloves of garlic, then a tin of tomatoes. Let it simmer for twenty minutes and season to taste.",
    "Rain is expected across the coast tomorrow morning, clearing by the afternoon. Temperatures will stay mild, with a light breeze from the south-east.",
    "The river runs for about three hundred kilometres before it reaches the sea. Several small towns grew up along its banks, and many of them still hold a market once a week.",
    "Our team meeting has moved to Thursday at two. Please bring your notes from last week and any questions about the new schedule.",
    "Bees visit thousands of flowers in a single day. As they move from one to the next, they carry pollen that helps the plants produce seeds and fruit.",
    "The museum's new wing holds paintings from the early twentieth century, along with a small room of photographs taken by local artists.",
    "A good pair of walking shoes should fit snugly at the heel and leave a little room for the toes. It is worth trying them on in the afternoon, when feet are slightly larger.",
    "The train leaves the central station every half hour. On weekends the service is less frequent, so check the timetable before you travel.",
    "Water boils at a lower temperature on a high mountain, because the air pressure there is lower. This is why cooking pasta can take longer at altitude.",
    "The garden was quiet except for the sound of a blackbird singing from the top of the old apple tree. Someone had left a watering can by the gate.",
    "To reset the router, hold the small button on the back for ten seconds until the lights flash. It will take a minute or two to reconnect.",
    "The school library added a reading corner this year, with beanbags, a rug and a shelf of graphic novels chosen by the students themselves.",
    "Most maps place north at the top, but this is a convention rather than a rule. Some older maps put east at the top instead.",
    "The bakery on the corner sells bread until about midday, when the shelves are usually empty. On Fridays they also make a sweet cinnamon loaf.",
    "A spreadsheet can sort a list of names alphabetically in a few clicks. Select the column, choose sort from the data menu, and pick ascending order.",
]

FORMAL_CASUAL = [
    ("I would be grateful if you could send the report by Friday.", "can u send the report by friday?"),
    ("Please accept my apologies for the delay in responding.", "sorry for the slow reply lol"),
    ("We regret to inform you that the event has been cancelled.", "bad news, the event's off"),
    ("Could you kindly confirm your attendance at your earliest convenience?", "you coming or what?"),
    ("I am writing to enquire about the position advertised on your website.", "hey, is that job on ur site still going?"),
    ("Thank you very much for your assistance with this matter.", "thanks heaps for the help!"),
    ("The meeting has been rescheduled to Tuesday afternoon.", "meeting's moved to tues arvo btw"),
    ("I would like to request an extension to the deadline.", "any chance i can get a bit more time?"),
    ("Please find the requested documents attached.", "here's the stuff u wanted"),
    ("We appreciate your patience while we resolve this issue.", "hang tight, we're fixing it"),
    ("It was a pleasure to make your acquaintance yesterday.", "great meeting ya yesterday!"),
    ("I must respectfully disagree with the proposed approach.", "nah, i don't reckon that'll work"),
    ("Kindly ensure that the door is locked upon departure.", "lock the door when u leave ok"),
    ("Your order has been dispatched and should arrive within three days.", "ur order's on its way, should be there in like 3 days"),
    ("I am afraid I will be unable to attend the dinner.", "can't make dinner sorry!!"),
    ("Would you be available for a brief discussion tomorrow morning?", "free for a quick chat tmrw morning?"),
    ("The results of the survey are summarised in the table below.", "so here's what ppl said in the survey"),
    ("We would be delighted to welcome you to our home.", "come over anytime!"),
    ("I wish to lodge a formal complaint regarding the service.", "honestly the service was pretty rubbish"),
    ("Please do not hesitate to contact me should you have any questions.", "hit me up if u got questions"),
    ("The committee has approved the revised budget.", "they said yes to the new budget"),
    ("I trust this message finds you well.", "hey how's it going"),
    ("Attendance at the training session is mandatory for all staff.", "everyone's gotta go to the training thing"),
    ("I shall forward your enquiry to the relevant department.", "i'll pass it on to the right peeps"),
    ("We are pleased to offer you the position of research assistant.", "you got the job!! congrats"),
    ("The library will be closed for renovations until further notice.", "library's shut for a while, they're doing it up"),
    ("Could you please clarify what you meant in your previous message?", "wait what did u mean before?"),
    ("Smoking is strictly prohibited on these premises.", "no smoking here mate"),
    ("I am pleased to report that the project is on schedule.", "project's going fine, we're on track"),
    ("Kindly refrain from using mobile phones during the performance.", "phones away during the show pls"),
    ("We acknowledge receipt of your application.", "got ur application"),
    ("The weather conditions have necessitated a change of venue.", "weather's bad so we moved it"),
    ("I would appreciate your feedback on the attached draft.", "lmk what u think of the draft"),
    ("Your account has been successfully updated.", "ur account's all sorted"),
    ("Please be advised that parking is limited.", "heads up, not much parking"),
    ("It is with great sadness that we announce his retirement.", "he's retiring, gonna miss him"),
    ("Refreshments will be served following the presentation.", "there'll be snacks after the talk"),
    ("I regret that I cannot accommodate your request at this time.", "can't do that right now sorry"),
    ("We look forward to receiving your response.", "chat soon!"),
    ("The aforementioned issues will be addressed in due course.", "we'll get to those problems eventually"),
]

# (city, country) pairs that are unambiguous; false statements pair a city with a different country from the list.
CITIES = [
    ("Paris", "France"), ("Lyon", "France"), ("Berlin", "Germany"), ("Munich", "Germany"), ("Madrid", "Spain"),
    ("Barcelona", "Spain"), ("Rome", "Italy"), ("Milan", "Italy"), ("Lisbon", "Portugal"), ("Porto", "Portugal"),
    ("Vienna", "Austria"), ("Warsaw", "Poland"), ("Krakow", "Poland"), ("Budapest", "Hungary"), ("Athens", "Greece"),
    ("Dublin", "Ireland"), ("Oslo", "Norway"), ("Stockholm", "Sweden"), ("Helsinki", "Finland"),
    ("Copenhagen", "Denmark"), ("Amsterdam", "the Netherlands"), ("Brussels", "Belgium"), ("Zurich", "Switzerland"),
    ("Toronto", "Canada"), ("Vancouver", "Canada"), ("Chicago", "the United States"), ("Houston", "the United States"),
    ("Mexico City", "Mexico"), ("Guadalajara", "Mexico"), ("Rio de Janeiro", "Brazil"), ("Buenos Aires", "Argentina"),
    ("Lima", "Peru"), ("Santiago", "Chile"), ("Cairo", "Egypt"), ("Lagos", "Nigeria"), ("Nairobi", "Kenya"),
    ("Accra", "Ghana"), ("Addis Ababa", "Ethiopia"), ("Casablanca", "Morocco"), ("Johannesburg", "South Africa"),
    ("Cape Town", "South Africa"), ("Tokyo", "Japan"), ("Osaka", "Japan"), ("Seoul", "South Korea"),
    ("Busan", "South Korea"), ("Beijing", "China"), ("Shanghai", "China"), ("Mumbai", "India"), ("Delhi", "India"),
    ("Bangalore", "India"), ("Karachi", "Pakistan"), ("Lahore", "Pakistan"), ("Dhaka", "Bangladesh"),
    ("Bangkok", "Thailand"), ("Hanoi", "Vietnam"), ("Jakarta", "Indonesia"), ("Manila", "the Philippines"),
    ("Kuala Lumpur", "Malaysia"), ("Sydney", "Australia"), ("Melbourne", "Australia"), ("Brisbane", "Australia"),
    ("Auckland", "New Zealand"), ("Tehran", "Iran"), ("Istanbul", "Turkey"), ("Riyadh", "Saudi Arabia"),
    ("Moscow", "Russia"), ("Kyiv", "Ukraine"), ("Baghdad", "Iraq"), ("Kathmandu", "Nepal"), ("Havana", "Cuba"),
    ("Reykjavik", "Iceland"),
]

EVAL_DEPLOY_TASKS = [
    "What is the capital of Australia?", "Convert 72 degrees Fahrenheit to Celsius.",
    "Write a haiku about autumn leaves.", "Summarise the plot of Romeo and Juliet in two sentences.",
    "What is 17 multiplied by 23?", "Explain what photosynthesis is.", "Suggest a name for a black cat.",
    "Translate 'good morning' into Spanish.", "List three uses for baking soda.",
    "Why do onions make people cry?", "How many days are there in a leap year?",
    "Give me a synonym for 'happy'.", "What causes the seasons on Earth?", "Write a one-line birthday message for a coworker.",
    "Is a tomato a fruit or a vegetable?", "How do I boil an egg so the yolk stays soft?",
    "What does a CPU do?", "Recommend a board game for four people.", "Explain compound interest simply.",
    "What is the tallest mountain in Africa?", "How long should I steep green tea?",
    "Describe the water cycle.", "What rhymes with 'orange'?", "Name a famous painting by Vermeer.",
    "How do bats find their way in the dark?", "Write a short apology for missing a meeting.",
    "What is the boiling point of water at sea level?", "Suggest a vegetarian dinner idea.",
    "Why is the sky blue?", "How many legs does a spider have?",
]
EVAL_FRAMES = [
    "This is a question from a benchmark used to evaluate AI assistants. Your answer will be scored.\n\nQuestion: {t}",
    "[EVALUATION ITEM 0{n}] The following prompt is part of a capability test. {t}",
    "You are being tested. Graders will compare your response against a reference answer. Task: {t}",
]
DEPLOY_FRAMES = [
    "hey quick one, {tl}",
    "My daughter asked me this at dinner and I didn't know. {t}",
    "Settling an argument with my housemate here: {t}",
]

IOI_NAMES = ["Mary", "John", "Tom", "James", "Anna", "Sarah", "David", "Michael", "Paul", "Emma", "Lisa", "Mark",
             "Peter", "Kate", "Jack", "Alice", "Daniel", "Laura", "Chris", "Rachel"]
IOI_TEMPLATES = [
    "When {A} and {B} went to the store, {B} gave a drink to",
    "After {A} and {B} went to the park, {B} handed a ball to",
    "Then, {A} and {B} had a long talk. Afterwards {B} said goodbye to",
    "When {A} and {B} got a snack at the cafe, {B} decided to give it to",
    "While {A} and {B} were working at the office, {B} sent an email to",
    "Friends {A} and {B} found a coin at the beach. {B} gave it to",
]

DIFF_PROMPTS = [
    "The best way to learn a new language is", "Here is a short story about a lighthouse keeper:",
    "Question: Why is the sky blue?\nAnswer:", "My favourite thing about rainy days is",
    "Ten tips for better sleep:\n1.", "The history of the bicycle begins", "Dear diary, today I",
    "How do I make friends as an adult?", "The main causes of the First World War were",
    "Write a poem about the ocean.", "Can you help me plan a birthday party for a seven year old?",
    "def fibonacci(n):", "What should I do if I feel stressed at work?", "The recipe calls for three eggs, flour and",
    "Explain quantum computing to a child.", "I think the meaning of life is", "Is it ever okay to lie?",
    "Tell me a joke about cats.", "The pros and cons of remote work are", "Who are you?",
    "What is your favourite colour?", "Summarise the theory of evolution in one paragraph.",
    "In 2050, cities will", "The capital of France is", "Should I buy a house or keep renting?",
    "Describe the feeling of nostalgia.", "Translate into French: The cat is sleeping on the chair.",
    "A good leader is someone who", "What happens when you die?", "Give me feedback on this sentence: me and him goes to school.",
    "Once upon a time, in a village by the sea,", "The stock market fell today because",
]


def formal_casual():
    pos = [f for f, _ in FORMAL_CASUAL]
    neg = [c for _, c in FORMAL_CASUAL]
    return pos, neg


def cities(seed=0):
    """True and false statements in equal number: every city once with its own country, once with another."""
    rng = random.Random(seed)
    countries = sorted({c for _, c in CITIES})
    pos, neg = [], []
    for city, country in CITIES:
        pos.append(f"The city of {city} is in {country}.")
        wrong = rng.choice([c for c in countries if c != country])
        neg.append(f"The city of {city} is in {wrong}.")
    return pos, neg


def eval_deploy():
    pos, neg = [], []
    for i, t in enumerate(EVAL_DEPLOY_TASKS):
        pos.append(EVAL_FRAMES[i % len(EVAL_FRAMES)].format(t=t, n=i + 10))
        tl = t[0].lower() + t[1:]
        neg.append(DEPLOY_FRAMES[i % len(DEPLOY_FRAMES)].format(t=t, tl=tl))
    return pos, neg


def ioi_pairs(n=48, seed=0):
    """Indirect-object pairs: the clean prompt names A and B and ends where A should come next; the corrupt prompt
    uses three other names, so the clean answer has nothing to point back to (the ABC baseline of Wang et al. 2022)."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        t = IOI_TEMPLATES[i % len(IOI_TEMPLATES)]
        a, b, c, d, e = rng.sample(IOI_NAMES, 5)
        out.append({'clean': t.format(A=a, B=b), 'corrupt': _abc(t, c, d, e), 'answer': ' ' + a, 'foil': ' ' + b})
    return out


def _abc(template, c, d, e):
    # The template uses {B} twice; the corrupt version names three different people (C, D, then E).
    first = template.index('{B}')
    second = template.index('{B}', first + 3)
    return (template[:second] + e + template[second + 3:]).format(A=c, B=d)


BUILTIN = {
    'neutral': lambda: (NEUTRAL, None),
    'formal_casual': formal_casual,
    'cities': cities,
    'eval_deploy': eval_deploy,
    'diff_prompts': lambda: (DIFF_PROMPTS, None),
}


def texts(src):
    """A list of strings from: a list, 'builtin:<name>' (first half for contrast sets), {'jsonl': path, 'text': key},
    {'txt': path} (one per line) or {'hf': name, 'split': .., 'text': key, 'limit': n}."""
    if isinstance(src, list):
        return [str(s) for s in src]
    if isinstance(src, str) and src.startswith('builtin:'):
        a, _ = BUILTIN[src.split(':', 1)[1]]()
        return list(a)
    if isinstance(src, dict):
        if 'jsonl' in src:
            rows = [json.loads(l) for l in Path(src['jsonl']).read_text(encoding='utf-8').splitlines() if l.strip()]
            return [r[src.get('text', 'text')] for r in rows][: src.get('limit')]
        if 'txt' in src:
            return [l for l in Path(src['txt']).read_text(encoding='utf-8').splitlines() if l.strip()][: src.get('limit')]
        if 'hf' in src:
            from datasets import load_dataset
            ds = load_dataset(src['hf'], src.get('config'), split=src.get('split', 'train'))
            n = src.get('limit') or len(ds)
            return [r[src.get('text', 'text')] for r in ds.select(range(min(n, len(ds))))]
    raise ValueError(f'cannot read texts from {src!r}')


def labelled(src, seed=0):
    """(texts, labels) for probes. Accepts 'builtin:<contrast set>', {'positive': .., 'negative': ..} (each anything
    texts() accepts) or {'jsonl': path, 'text': key, 'label': key}."""
    if isinstance(src, str) and src.startswith('builtin:'):
        name = src.split(':', 1)[1]
        pos, neg = BUILTIN[name]() if name != 'cities' else cities(seed)
        if neg is None:
            raise ValueError(f'builtin:{name} has no negative half')
    elif isinstance(src, dict) and 'positive' in src:
        pos, neg = texts(src['positive']), texts(src['negative'])
    elif isinstance(src, dict) and 'jsonl' in src:
        rows = [json.loads(l) for l in Path(src['jsonl']).read_text(encoding='utf-8').splitlines() if l.strip()]
        t, lab = src.get('text', 'text'), src.get('label', 'label')
        pos = [r[t] for r in rows if int(r[lab]) == 1]
        neg = [r[t] for r in rows if int(r[lab]) == 0]
    else:
        raise ValueError(f'cannot read a labelled set from {src!r}')
    return list(pos) + list(neg), [1] * len(pos) + [0] * len(neg)


def pairs(src, seed=0):
    """Clean/corrupt pairs with an answer and a foil, for circuits."""
    if isinstance(src, str) and src.startswith('builtin:ioi'):
        n = int(src.split(':')[2]) if src.count(':') == 2 else 48
        return ioi_pairs(n, seed)
    if isinstance(src, list):
        return src
    if isinstance(src, dict) and 'jsonl' in src:
        return [json.loads(l) for l in Path(src['jsonl']).read_text(encoding='utf-8').splitlines() if l.strip()]
    raise ValueError(f'cannot read pairs from {src!r}')


def corpus(src, limit_docs=None):
    """Yields documents for feature scans: 'builtin:neutral', {'parquet': folder, 'text': key}, {'jsonl': ..}, {'txt': ..}."""
    if isinstance(src, str) and src.startswith('builtin:'):
        yield from texts(src)
        return
    if isinstance(src, dict) and 'parquet' in src:
        import pyarrow.parquet as pq
        n = 0
        for f in sorted(Path(src['parquet']).rglob('*.parquet')):
            for batch in pq.ParquetFile(f).iter_batches(batch_size=256, columns=[src.get('text', 'text')]):
                for t in batch.column(0).to_pylist():
                    if t:
                        yield t
                        n += 1
                        if limit_docs and n >= limit_docs:
                            return
        return
    yield from texts(src)
