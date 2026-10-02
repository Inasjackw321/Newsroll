// Works out what kind of question was asked, so only real news questions go
// through story search and the model. Maths is answered exactly here, since
// small models are unreliable at arithmetic.

const PREFIX = /^\s*(what('s| is)|calculate|compute|solve|how much is|whats)\s+/i;

// Evaluates + - * / % ^ and parentheses. Returns a number, or null if the
// text isn't a plain calculation.
function evalMath(input) {
  const src = String(input).replace(PREFIX, '').replace(/[=?]+\s*$/, '').replace(/[×x]/gi, '*').replace(/÷/g, '/').replace(/,/g, '').trim();
  if (!/\d/.test(src) || !/^[\d\s+\-*/%^().]+$/.test(src) || !/[+\-*/%^]/.test(src)) return null;

  const tokens = src.match(/\d+(?:\.\d+)?|[+\-*/%^()]/g);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  // Recursive descent: expr → term (('+'|'-') term)*
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = power();
    while (['*', '/', '%'].includes(peek())) {
      const op = take();
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function power() {
    const base = unary();
    return peek() === '^' ? (take(), base ** power()) : base;
  }
  function unary() {
    if (peek() === '-') return take(), -unary();
    if (peek() === '+') return take(), unary();
    return atom();
  }
  function atom() {
    const t = take();
    if (t === '(') {
      const v = expr();
      if (take() !== ')') throw new Error('bracket');
      return v;
    }
    if (t === undefined || Number.isNaN(Number(t))) throw new Error('number');
    return Number(t);
  }

  try {
    const value = expr();
    return pos === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function formatNumber(n) {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : Number(n.toPrecision(10)).toString();
}

const GREETING = /^\s*(hi|hello|hey|yo|hiya|howdy|sup|good (morning|afternoon|evening)|thanks|thank you|cheers|ok|okay|cool)\b[\s!.,?]*(there|newsroll)?[\s!.?]*$/i;
const HELP = /^\s*(help|what can you do|what do you do|how do (i|you) (use|work)|who are you|what are you|how does this work)\b/i;

// Short follow-ups like "why?" or "tell me more" lean on the previous question.
const FOLLOW_UP = /^\s*(why|how come|and|so|what about|tell me more|more|go on|really|explain|what does that mean|who is (he|she|that)|when)\b|\b(it|that|this|they|them|he|she|those|these)\b/i;

function classify(question) {
  const q = String(question || '').trim();
  if (evalMath(q) !== null) return 'math';
  if (GREETING.test(q)) return 'greeting';
  if (HELP.test(q)) return 'help';
  return 'news';
}

const isFollowUp = (question) => {
  const q = String(question || '').trim();
  return q.split(/\s+/).length <= 7 && FOLLOW_UP.test(q);
};

module.exports = { classify, evalMath, formatNumber, isFollowUp };
