const { useState, useEffect } = React;

// Add this utility function near the top
function sanitizeNumber(value, fallback = 0) {
  const num = Number(value);
  return !isNaN(num) && isFinite(num) ? num : fallback;
}

function TierBadge({ tier }) {
  const colors = {
    S: 'bg-purple-600',  // legendary
    A: 'bg-blue-600',    // rare
    B: 'bg-green-600',   // uncommon
    C: 'bg-yellow-600',  // common
    U: 'bg-gray-600'     // undefined
  };

  return (
    <span className={`${colors[tier]} px-2 py-1 rounded text-xs font-bold`}>
      Tier {tier}
    </span>
  );
}

function ProgressRing({ value, maxValue, size = 120, strokeWidth = 8, color = '#60A5FA', centerContent }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const progress = value / maxValue;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#374151"
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          fill="transparent"
          className="transition-all duration-500 ease-out"
        />
      </svg>
      <div className="absolute text-center">
        {centerContent}
      </div>
    </div>
  );
}

function TierFilter({ selectedTier, onTierChange }) {
  const tiers = ['All', 'S', 'A', 'B', 'C', 'U'];
  const colors = {
    S: 'bg-purple-600',
    A: 'bg-blue-600',
    B: 'bg-green-600',
    C: 'bg-yellow-600',
    U: 'bg-gray-600'
  };

  return (
    <div className="flex gap-2 justify-center mb-6">
      {tiers.map(tier => (
        <button
          key={tier}
          className={`px-3 py-1 rounded ${
            selectedTier === tier 
              ? tier === 'All' 
                ? 'bg-white text-gray-900' 
                : `${colors[tier]} text-white`
              : 'bg-gray-700 text-gray-300'
          }`}
          onClick={() => onTierChange(tier)}
        >
          {tier}
        </button>
      ))}
    </div>
  );
}

function AvatarDetailModal({ avatar, onClose }) {
  const [reflections, setReflections] = useState([]);
  const [dungeonStats, setDungeonStats] = useState({ attack: 0, defense: 0, hp: 0 });
  const formatDate = (date) => new Date(date).toLocaleString();

  useEffect(() => {
    if (avatar) {
      fetch(`/api/avatar/${avatar._id}/reflections`)
        .then(res => res.json())
        .then(data => {
          setReflections(data.reflections);
          setDungeonStats(data.dungeonStats);
        });
    }
  }, [avatar]);

  if (!avatar) return null;

  const { 
    attack = 0, 
    defense = 0, 
    hp = 0, 
    lives = null,
    status
  } = avatar;

  // Sanitize all numerical values
  const safeHP = sanitizeNumber(hp);
  const safeLives = sanitizeNumber(lives);
  const safeAttack = sanitizeNumber(dungeonStats.attack || attack);
  const safeDefense = sanitizeNumber(dungeonStats.defense || defense);
  const currentHP = Math.min(Math.max(safeHP, 0), 100);

  const isDead = lives === 0;
  const showHPRing = lives !== null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-gray-800 rounded-lg p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex gap-6">
          <div className="w-1/3">
            <img 
              src={avatar.imageUrl}
              alt={avatar.name}
              className="w-full aspect-[2/3] object-cover rounded-lg"
            />
            {/* Stats section */}
          </div>
          <div className="w-2/3">
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center space-x-4">
                <img 
                  src={avatar.imageUrl} 
                  alt={avatar.name}
                  className="w-24 h-24 rounded-full object-cover"
                />
                <div>
                  <h2 className="text-3xl font-bold">{avatar.name} {avatar.emoji}</h2>
                  <p className="text-gray-400">Messages: {avatar.messageCount}</p>
                  <p className="text-gray-500">Created: {formatDate(avatar.createdAt)}</p>
                  {/* Display Dungeon Stats */}
                  <div className="mt-4 flex items-center gap-6">
                    {isDead ? (
                      <div className="text-red-500 text-2xl font-bold">☠️ Dead</div>
                    ) : showHPRing ? (
                      <ProgressRing 
                        value={currentHP}
                        maxValue={100}
                        size={100}
                        color={currentHP < 33 ? '#EF4444' : '#60A5FA'}
                        centerContent={
                          <div>
                            <div className="text-2xl font-bold">{currentHP}</div>
                            <div className="text-sm text-gray-400">{safeLives} ❣️</div>
                          </div>
                        }
                      />
                    ) : null}
                    <div className="space-y-2">
                      {safeAttack > 0 && (
                        <div className="flex gap-2 items-center">
                          <span className="text-gray-400 w-20">Attack:</span>
                          <span>{Array(Math.min(Math.floor(safeAttack/5), 5)).fill('⚔️').join('')}</span>
                          <span className="text-gray-500">({safeAttack})</span>
                        </div>
                      )}
                      {safeDefense > 0 && (
                        <div className="flex gap-2 items-center">
                          <span className="text-gray-400 w-20">Defense:</span>
                          <span>{Array(Math.min(Math.floor(safeDefense/5), 5)).fill('🛡️').join('')}</span>
                          <span className="text-gray-500">({safeDefense})</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">×</button>
            </div>

            {/* Add alternate avatars section if they exist */}
            {avatar.alternateAvatars?.length > 0 && (
              <div className="mt-4 bg-gray-700 rounded-lg p-4">
                <h3 className="text-xl font-bold mb-2">Alternate Avatars</h3>
                <div className="flex flex-wrap gap-4">
                  {avatar.alternateAvatars.map((altAvatar, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <img 
                        src={altAvatar.imageUrl} 
                        alt={altAvatar.name}
                        className="w-12 h-12 rounded-full object-cover"
                      />
                      <div>
                        <div className="font-bold">{altAvatar.emoji}</div>
                        <div className="text-sm text-gray-400">Tier {calculateTier(altAvatar)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
              <div className="space-y-4">
                <div className="bg-gray-700 rounded-lg p-4">
                  <h3 className="text-xl font-bold mb-2">Description</h3>
                  <p className="text-gray-300">{avatar.description}</p>
                </div>

                <div className="bg-gray-700 rounded-lg p-4">
                  <h3 className="text-xl font-bold mb-2">Personality</h3>
                  <p className="text-gray-300">{avatar.dynamicPersonality}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="bg-gray-700 rounded-lg p-4">
                  <h3 className="text-xl font-bold mb-2">Recent Messages</h3>
                  <div className="space-y-2">
                    {(avatar.recentMessages || []).map((msg, i) => (
                      <div key={i} className="text-sm">
                        <p className="text-gray-300">{msg.content}</p>
                        <p className="text-gray-500 text-xs">{formatDate(msg.timestamp)}</p>
                      </div>
                    ))}
                    {(!avatar.recentMessages || avatar.recentMessages.length === 0) && (
                      <p className="text-gray-500">No recent messages</p>
                    )}
                  </div>
                </div>

                <div className="bg-gray-700 rounded-lg p-4">
                  <h3 className="text-xl font-bold mb-2">Recent Reflections</h3>
                  <div className="space-y-2">
                    {reflections.map((reflection, i) => (
                      <div key={i} className="border-b border-gray-600 pb-2 mb-2 last:border-0">
                        <p className="text-gray-300">{reflection.reflectionContent}</p>
                        <p className="text-gray-500 text-xs">{formatDate(reflection.timestamp)}</p>
                      </div>
                    ))}
                    {reflections.length === 0 && (
                      <p className="text-gray-500">No reflections yet</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AvatarCard({ avatar, onSelect }) {
  const { 
    attack = 0, 
    defense = 0, 
    hp = 0, 
    lives = null,
    status
  } = avatar;

  // Sanitize all numerical values
  const safeHP = sanitizeNumber(hp);
  const safeLives = sanitizeNumber(lives);
  const safeAttack = sanitizeNumber(attack);
  const safeDefense = sanitizeNumber(defense);
  const currentHP = Math.min(Math.max(safeHP, 0), 100); // Clamp between 0-100

  // Only show HP ring if lives is defined, show dead status if lives is 0
  const isDead = lives === 0;
  const showHPRing = lives !== null;

  return (
    <div onClick={() => onSelect(avatar)} 
         className="bg-gray-800 rounded-lg p-3 cursor-pointer hover:bg-gray-700 transition-colors">
      <div className="flex items-center gap-3">
        <img 
          src={avatar.thumbnailUrl || avatar.imageUrl} 
          alt={avatar.name} 
          className="w-12 h-12 rounded-full object-cover"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold truncate">{avatar.name}</h3>
            <span>{avatar.emoji}</span>
            <TierBadge tier={avatar.tier} />
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span>✉️ {avatar.messageCount}</span>
            {avatar.attack > 0 && <span>⚔️ {avatar.attack}</span>}
            {avatar.defense > 0 && <span>🛡️ {avatar.defense}</span>}
            {avatar.lives !== null && (
              <span className={avatar.lives === 0 ? 'text-red-500' : ''}>
                ❣️ {avatar.lives}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CombatLog() {
  const [combatLog, setCombatLog] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchCombatLog = async () => {
      try {
        const response = await fetch('/api/dungeon/log');
        const data = await response.json();
        setCombatLog(data);
      } catch (error) {
        console.error('Error fetching combat log:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchCombatLog();
    const interval = setInterval(fetchCombatLog, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="text-center py-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {combatLog.map((entry, index) => (
        <CombatLogEntry key={index} entry={entry} />
      ))}
      {combatLog.length === 0 && (
        <div className="text-center text-gray-500">No combat actions yet</div>
      )}
    </div>
  );
}

function CombatLogEntry({ entry }) {
  return (
    <div className="bg-gray-800 rounded-lg p-3">
      <div className="flex items-center gap-3">
        {entry.imageUrl && (
          <img 
            src={entry.thumbnailUrl || entry.imageUrl} 
            alt={entry.avatarName}
            className="w-10 h-10 rounded-full object-cover"
          />
        )}
        <div className="flex-1">
          <div className="flex justify-between items-start">
            <span>{entry.result}</span>
            <span className="text-xs text-gray-400">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="text-sm text-gray-400 flex gap-2 items-center">
            {entry.avatarName}
            {entry.targetImageUrl && (
              <>
                <span>➜</span>
                <img 
                  src={entry.targetThumbnailUrl || entry.targetImageUrl} 
                  alt={entry.targetName}
                  className="w-6 h-6 rounded-full object-cover"
                />
                <span>{entry.targetName}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ViewToggle({ currentView, onViewChange }) {
  return (
    <div className="flex justify-center gap-4 mb-8">
      <button
        className={`px-4 py-2 rounded ${
          currentView === 'leaderboard' 
            ? 'bg-blue-600 text-white' 
            : 'bg-gray-700 text-gray-300'
        }`}
        onClick={() => onViewChange('leaderboard')}
      >
        Leaderboard
      </button>
      <button
        className={`px-4 py-2 rounded ${
          currentView === 'combat' 
            ? 'bg-red-600 text-white' 
            : 'bg-gray-700 text-gray-300'
        }`}
        onClick={() => onViewChange('combat')}
      >
        Combat Log
      </button>
      <button
        className={`px-4 py-2 rounded ${
          currentView === 'families' 
            ? 'bg-green-600 text-white' 
            : 'bg-gray-700 text-gray-300'
        }`}
        onClick={() => onViewChange('families')}
      >
        Families
      </button>
    </div>
  );
}

function FamilyCard({ family, onSelect }) {
  // Ensure descendants exists and is an array
  const descendantsCount = Array.isArray(family.descendants) ? family.descendants.length : 0;

  return (
    <div 
      onClick={() => onSelect(family)}
      className="bg-gray-800 rounded-lg p-4 cursor-pointer hover:bg-gray-700 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <img 
            src={family.thumbnailUrl || family.imageUrl} 
            alt={family.name}
            className="w-16 h-16 rounded-full object-cover"
          />
          <div>
            <span className="text-2xl">{family.emoji}</span>
            <div className="text-xl font-bold">{family.name}</div>
            <div className="text-gray-400">
              {descendantsCount} descendants
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FamilyView() {
  const [families, setFamilies] = useState([]);
  const [selectedFamily, setSelectedFamily] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchFamilies = async () => {
      try {
        const response = await fetch('/api/families');
        const data = await response.json();
        setFamilies(data);
      } catch (error) {
        console.error('Error fetching families:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchFamilies();
  }, []);

  if (loading) {
    return (
      <div className="text-center py-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
      </div>
    );
  }

  const renderFamilyTree = (family, depth = 0) => {
    return (
      <div key={family._id} className="ml-6">
        <div className="flex items-center gap-3 p-2 hover:bg-gray-700 rounded">
          <img 
            src={family.thumbnailUrl || family.imageUrl}
            alt={family.name}
            className="w-10 h-10 rounded-full object-cover"
          />
          <div>
            <span>{family.emoji}</span>
            <span className="font-bold ml-2">{family.name}</span>
          </div>
        </div>
        {family.descendants?.map(child => renderFamilyTree(child, depth + 1))}
      </div>
    );
  };
  
  return (
    <div className="space-y-4">
      {families.map(family => renderFamilyTree(family))}
    </div>
  );
}

function App() {
  const [avatars, setAvatars] = useState([]);
  const [selectedAvatar, setSelectedAvatar] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [lastMessageCount, setLastMessageCount] = useState(null);
  const [lastId, setLastId] = useState(null);
  const [selectedTier, setSelectedTier] = useState('All');
  const [currentView, setCurrentView] = useState('leaderboard');
  
  const loadAvatars = async (isInitial = false) => {
    if (loading || (!hasMore && !isInitial)) return;
    
    setLoading(true);
    try {
      const url = new URL('/api/leaderboard', window.location.origin);
      url.searchParams.set('limit', '24');
      
      if (selectedTier !== 'All') {
        url.searchParams.set('tier', selectedTier);
      }
      
      if (!isInitial && lastMessageCount !== null && lastId) {
        url.searchParams.set('lastMessageCount', lastMessageCount);
        url.searchParams.set('lastId', lastId);
      }
      
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      
      if (isInitial) {
        setAvatars(data.avatars || []);
      } else {
        setAvatars(prev => [...prev, ...(data.avatars || [])]);
      }
      
      setHasMore(data.hasMore);
      setLastMessageCount(data.lastMessageCount);
      setLastId(data.lastId);
    } catch (error) {
      console.error('Error loading avatars:', error);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAvatars(true);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1000 &&
        !loading &&
        hasMore
      ) {
        loadAvatars();
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [loading, hasMore, lastMessageCount, lastId]);

  useEffect(() => {
    setLastMessageCount(null);
    setLastId(null);
    setHasMore(true);
    setAvatars([]);
    loadAvatars(true);
  }, [selectedTier]);

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-8 text-center">Avatar Dashboard</h1>
      <ViewToggle currentView={currentView} onViewChange={setCurrentView} />
      
      {currentView === 'leaderboard' ? (
        <>
          <TierFilter 
            selectedTier={selectedTier} 
            onTierChange={tier => setSelectedTier(tier)} 
          />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {(avatars || []).map(avatar => (
              <AvatarCard 
                key={avatar._id} 
                avatar={avatar} 
                onSelect={setSelectedAvatar}
              />
            ))}
          </div>
          {loading && (
            <div className="text-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
            </div>
          )}
          <AvatarDetailModal 
            avatar={selectedAvatar} 
            onClose={() => setSelectedAvatar(null)} 
          />
        </>
      ) : currentView === 'combat' ? (
        <CombatLog />
      ) : (
        <FamilyView />
      )}
    </div>
  );
}

const rootElement = document.getElementById('root');
ReactDOM.createRoot(rootElement).render(<App />);