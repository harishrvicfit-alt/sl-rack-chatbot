export const companyFacts = {
  name: 'SL Rack GmbH',
  headquarters: 'Haag in Oberbayern, Germany',
  coreBusiness: 'Photovoltaic mounting systems and substructures for roofs, ground-mounted solar, facades, carports and Agri-PV.',
  positioning: [
    'installer-friendly mounting systems',
    'modular product logic with fewer components',
    'high safety standards and durable aluminum/stainless steel materials',
    'planning support through SL Planner and Solar.Pro.Tool',
    'German engineering with production sites in Germany and Europe'
  ],
  values: ['Sicherheit', 'Leidenschaft', 'Respekt']
};

export const productCatalog = [
  {
    id: 'pitched-roof',
    name: 'Schraeg- & Blechdachsysteme',
    category: 'Roof',
    bestFor: ['pitched roof', 'tile roof', 'trapezoidal sheet', 'standing seam', 'residential', 'commercial roof'],
    triggerWords: ['schraeg', 'pitched', 'tile', 'ziegel', 'trapez', 'metal roof', 'blech', 'falz', 'roof hook'],
    shortPitch: 'Complete modular mounting system for pitched and sheet-metal roofs with fast installation and high compatibility.',
    keyProducts: [
      'Dachhaken',
      'Alpha-Platte',
      'Beta-Platte',
      'Delta-Platte',
      'Dachersatzplatten',
      'Trapez 1-6',
      'RAIL',
      'Modulklemmen',
      'Falzklemmen',
      'Schneefang'
    ],
    advantages: [
      'fast installation with only a few core components',
      'height-adjustable roof hooks and flexible rail configurations',
      'integrated equipotential bonding and lightning protection logic',
      'compatible with many roof types and module frames'
    ],
    questions: [
      'Which exact roof covering/tile model is used?',
      'For tile roofs: is it Tonziegel or Betondachstein?',
      'What is the roof pitch and rafter spacing?',
      'Which module layout, wind zone and snow load zone apply?'
    ]
  },
  {
    id: 'flat-roof',
    name: 'SL Fast Flat / Flachdach Generation 2.0',
    category: 'Flat roof',
    bestFor: ['flat roof', 'commercial roof', 'low ballast', 'east-west', 'south orientation'],
    triggerWords: ['flat', 'flach', 'ballast', 'east-west', 'ost-west', 'sued', 'roof load'],
    shortPitch: 'Ballast-optimized flat-roof systems for south and east-west layouts with fast, safe and economical installation.',
    keyProducts: ['SL Fast Flat', 'Flachdach Generation 2.0'],
    advantages: [
      'minimal roof load through optimized ballast',
      'pre-assembled and tool-friendly components',
      'flexible clamping for different module sizes',
      'durable and lightning-current capable construction'
    ],
    questions: ['What is the roof membrane and load reserve?', 'South or east-west orientation?', 'Is roof penetration allowed?', 'What wind and snow zone applies?']
  },
  {
    id: 'ground-mount',
    name: 'Freiflaechensysteme',
    category: 'Ground mount',
    bestFor: ['utility scale', 'solar park', 'ground-mounted', 'difficult soil', 'hilly terrain'],
    triggerWords: ['ground', 'freiflaeche', 'solar park', 'utility', 'soil', 'terrain', 'farmland', 'ramming', 'foundation'],
    shortPitch: 'Flexible ground-mounted PV systems for large projects with geotechnical support, optimized spans and durable stability.',
    keyProducts: ['W-Rammprofil', 'Binder', 'Z-Strebe', 'Z-Pfette', 'Sparren 80', 'Sparren 100', 'Pfetten-Klemme-Duo'],
    advantages: [
      'adaptable to terrain and soil conditions',
      'reduced foundations through optimized spans',
      'single-post, two-post, Agri-PV and east-west variants',
      'geological and static planning support'
    ],
    questions: ['What soil report is available?', 'Is the site flat or hilly?', 'Which module orientation and row spacing are planned?', 'Are agricultural uses required below or between rows?']
  },
  {
    id: 'facade',
    name: 'SL Energy Wall Fassadensystem',
    category: 'Facade',
    bestFor: ['facade', 'building integrated', 'aesthetic PV', 'vertical modules'],
    triggerWords: ['facade', 'fassade', 'wall', 'building', 'vertical', 'aesthetic', 'energy wall'],
    shortPitch: 'Aesthetic facade PV mounting system with near-invisible fixation and integrated safety details.',
    keyProducts: ['Fassadensystem unten/mitte/oben', 'Abdeckprofil', 'Endkappe', 'Fassadenbefestiger'],
    advantages: [
      'near-invisible module fastening',
      'horizontal and vertical installation possible',
      'integrated equipotential bonding and water drainage',
      'black anodized aluminum and stainless-steel screws'
    ],
    questions: ['What facade substructure is available?', 'Horizontal or vertical module layout?', 'Which module frame height?', 'Are architectural appearance requirements defined?']
  },
  {
    id: 'carport',
    name: 'Carportsysteme',
    category: 'Carport',
    bestFor: ['parking', 'carport', 'commercial parking', 'public parking', 'rain protection'],
    triggerWords: ['carport', 'parking', 'stellplatz', 'rain', 'regenschutz', 'trapezoidal roof'],
    shortPitch: 'PV-ready aluminum and steel carport kit with single-sided, double-sided and Y variants.',
    keyProducts: ['Carportpfette', 'Carportbinder', 'Carportstuetzenrohr', 'Fundamentschuh'],
    advantages: [
      'complete ready-to-install kit',
      'sun-shade and rain-protection variants',
      'static calculation for the module substructure',
      '5, 10 and 15 degree inclination options'
    ],
    questions: ['How many parking spaces are planned?', 'Sun protection only or rain protection too?', 'Single-sided, double-sided or Y layout?', 'Private, commercial or public site?']
  },
  {
    id: 'agri-pv',
    name: 'SL Agri Wall / SL Tracker',
    category: 'Agri-PV',
    bestFor: ['agriculture', 'dual land use', 'vertical agri pv', 'tracking', 'high yield'],
    triggerWords: ['agri', 'farm', 'agriculture', 'tracker', 'vertical', 'crop', 'land use', 'dual use'],
    shortPitch: 'Agri-PV solutions for combining electricity generation and agriculture with vertical walls or active tracking.',
    keyProducts: ['SL Agri Wall', 'SL Tracker'],
    advantages: [
      'dual land use for agriculture and energy generation',
      'SL Agri Wall minimizes sealed area and preserves agricultural use',
      'SL Tracker increases energy yield through active single-axis tracking',
      'robust pre-assembled components for outdoor conditions'
    ],
    questions: ['Which agricultural use must remain?', 'Is fixed vertical PV or active tracking preferred?', 'What machinery clearance is required?', 'What slope and row spacing are available?']
  }
];

export function scoreProducts(profile = {}) {
  const text = [
    profile.projectType,
    profile.surface,
    profile.priority,
    profile.orientation,
    profile.message
  ].filter(Boolean).join(' ').toLowerCase();

  const ranked = productCatalog
    .map((product) => {
      let score = 0;

      for (const word of product.triggerWords) {
        if (text.includes(word.toLowerCase())) score += 4;
      }

      for (const fit of product.bestFor) {
        if (text.includes(fit.toLowerCase())) score += 2;
      }

      if (profile.projectType === product.id) score += 10;
      if (profile.projectType === 'agri-pv' && product.id === 'ground-mount') score += 3;
      if (profile.projectType === 'ground-mount' && product.id === 'agri-pv') score += 2;
      if (text.includes('agri') && product.id === 'ground-mount') score += 3;
      if (!text && product.id === 'pitched-roof') score += 1;

      return {
        ...product,
        score,
        confidence: Math.min(98, 55 + score * 7)
      };
    })
    .sort((a, b) => b.score - a.score);

  const positive = ranked.filter((product) => product.score > 0);
  return positive.length ? positive.concat(ranked.filter((product) => product.score === 0)) : ranked;
}
