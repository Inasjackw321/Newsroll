// Offline demo stories, used only when every configured feed fails to load
// (no network, firewalled, etc.) so the timeline is never empty.
const { makeId } = require('./rss');

const SAMPLES = [
  ['Global Wire', 'Leaders gather for climate summit as emissions hit new record', 'Delegates from nearly 200 countries meet this week, with negotiators pushing for faster cuts to carbon emissions and new funding for vulnerable nations.'],
  ['Tech Daily', 'New open-source AI model runs entirely on a laptop', 'Researchers released a compact language model that can summarise documents and answer questions without an internet connection.'],
  ['Market Watch', 'Stocks edge higher as inflation cools for third month', 'Investors welcomed figures showing price rises slowing, raising hopes that central banks could begin cutting interest rates.'],
  ['Science Now', 'Telescope spots water vapour on distant rocky planet', 'Astronomers say the finding makes the planet one of the most promising places to study whether worlds beyond our solar system could host life.'],
  ['Global Wire', 'Ceasefire talks resume after week-long pause', 'Mediators said both sides had agreed to return to negotiations, though major disagreements remain over border security.'],
  ['Health Desk', 'Hospitals trial AI tool that spots early signs of sepsis', 'Doctors say the system flagged patients hours earlier than standard checks, but warn that larger studies are still needed.'],
  ['Sport Line', 'Underdogs stun champions in dramatic league final', 'A late goal secured a first title in 40 years for the club, sparking celebrations across the city.'],
  ['Culture Club', 'Indie film sweeps festival awards', 'The low-budget drama, shot in just 18 days, won best picture, best director and the audience prize.'],
  ['Market Watch', 'Chipmaker shares jump on record quarterly profit', 'Demand for data-centre hardware pushed revenue well beyond analyst expectations.'],
  ['Global Wire', 'Parliament passes landmark data privacy law', 'The new rules give people the right to see and delete personal data held by tech companies, with large fines for breaches.'],
  ['Climate Desk', 'Severe storm forces thousands to evacuate coastal towns', 'Emergency services opened shelters as forecasters warned of flooding and winds of up to 120 km/h.'],
  ['Tech Daily', 'Smartphone makers agree on universal repair standard', 'The agreement means batteries and screens should be replaceable with common tools by 2028.'],
  ['Science Now', 'Ancient fossil reveals new species of feathered dinosaur', 'Palaeontologists say the well-preserved skeleton sheds light on how flight evolved.'],
  ['Health Desk', 'Study links short daily walks to better sleep', 'Participants who walked 20 minutes a day reported falling asleep faster and waking less often.'],
  ['Sport Line', 'Tennis star announces retirement after 20-year career', 'The four-time grand slam champion said she would play one final tournament on home soil.'],
  ['Market Watch', 'Oil prices slide as supply concerns ease', 'Crude fell for a fourth straight session after producers signalled they would raise output.'],
  ['Global Wire', 'Election officials report record early voter turnout', 'More than 30 million ballots have already been cast, according to the national election commission.'],
  ['Culture Club', 'Museum returns looted artefacts after decades-long campaign', 'The collection of bronze sculptures will go on display in a new national gallery next year.'],
];

function sampleItems() {
  const now = Date.now();
  return SAMPLES.map(([source, title, summary], i) => {
    const link = `https://example.com/story/${i + 1}`;
    return {
      id: makeId(link, title),
      title,
      link,
      summary,
      image: '',
      source,
      // Spread stories across roughly the last two days.
      published: new Date(now - (i * 2.6 + (i % 3) * 0.7) * 3600e3).toISOString(),
    };
  });
}

module.exports = { sampleItems };
