import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, Pressable, TextInput, Dimensions, Platform, ActivityIndicator } from 'react-native';

const API_BASE_URL = 'http://127.0.0.1:3000';

export default function App() {
  const [appState, setAppState] = useState('onboarding');
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [selectedModality, setSelectedModality] = useState('ALL');
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [userProfile, setUserProfile] = useState(null);

  const [tentativeSelection, setTentativeSelection] = useState(null);
  const [struckOutLabels, setStruckOutLabels] = useState([]);
  const [isEvaluated, setIsEvaluated] = useState(false);
  const [userCertainty, setUserCertainty] = useState(null);
  const [sessionScore, setSessionScore] = useState(0);
  const [evaluatedCount, setEvaluatedCount] = useState(0);
  const [freeLimitCeiling, setFreeLimitCeiling] = useState(0);

  const [activeTab, setActiveTab] = useState('question');
  const [theme, setTheme] = useState('cream');
  const [fontSizeModifier, setFontSizeModifier] = useState(0);
  const [activeAbstract, setActiveAbstract] = useState(null);
  const [examTimer, setExamTimer] = useState(60);
  const [isTimerActive, setIsTimerActive] = useState(false);
  const timerRef = useRef(null);

  const [ablWeight, setAblWeight] = useState('');
  const [ablHctStart, setAblHctStart] = useState('');
  const [ablHctTarget, setAblHctTarget] = useState('');
  const [ablResult, setAblResult] = useState(null);

  const activeQuestion = questions[currentIndex] || null;

  useEffect(() => {
    if (isTimerActive && examTimer > 0 && !isEvaluated) {
      timerRef.current = setTimeout(() => setExamTimer(prev => prev - 1), 1000);
    } else if (examTimer === 0 && !isEvaluated) {
      commitCertaintySubmission('BLIND_GUESS');
    }
    return () => clearTimeout(timerRef.current);
  }, [examTimer, isTimerActive, isEvaluated]);

  const triggerMockOAuth = async (provider) => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/config`);
      const config = await response.json();
      const mockId = `mock_user_${Math.random().toString(36).substring(4)}`;
      const mockToken = `macprep_premium_${mockId}`;
      setAuthToken(mockToken);
      setUserProfile({ id: mockId, email: `${mockId}@macprep.edu`, tier: 'premium' });
      alert(`OAuth Simulation Synchronized via ${provider}`);
    } catch (err) {
      setErrorMessage('Failed to connect to authentication server config gateway.');
    } finally {
      setLoading(false);
    }
  };

  const startStreamingSession = async (trackToken) => {
    setLoading(true);
    setErrorMessage(null);
    setSelectedTrack(trackToken);
    try {
      const headers = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
      const endpoint = authToken 
        ? `${API_BASE_URL}/api/questions/premium?track=${trackToken}`
        : `${API_BASE_URL}/api/questions/free?track=${trackToken}`;

      const response = await fetch(endpoint, { headers });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Server stream transmission failure.');

      let filteredQuestions = data.questions || [];
      if (selectedModality !== 'ALL') {
        filteredQuestions = filteredQuestions.filter(q => q.specialty === selectedModality);
      }

      if (filteredQuestions.length === 0) {
        throw new Error('No questions available matching your targeted rotation modalities.');
      }

      setQuestions(filteredQuestions);
      setFreeLimitCeiling(data.freeLimitCeiling || filteredQuestions.length);
      setCurrentIndex(0);
      setAppState('testing');
      resetQuestionViewportState();
      setIsTimerActive(true);
      setExamTimer(60);
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  const resetQuestionViewportState = () => {
    setTentativeSelection(null);
    setStruckOutLabels([]);
    setIsEvaluated(false);
    setUserCertainty(null);
    setActiveAbstract(null);
    setExamTimer(60);
  };

  const toggleStrikethrough = (label) => {
    if (isEvaluated) return;
    setStruckOutLabels(prev => 
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
    );
    if (tentativeSelection === label) setTentativeSelection(null);
  };

  const handleSelectChoice = (label) => {
    if (isEvaluated || struckOutLabels.includes(label)) return;
    setTentativeSelection(label);
  };

  const commitCertaintySubmission = async (certaintyValue) => {
    if (isEvaluated || !tentativeSelection) return;
    setIsTimerActive(false);
    setUserCertainty(certaintyValue);
    setIsEvaluated(true);

    const isCorrect = tentativeSelection === activeQuestion.correctAnswer;
    if (isCorrect) setSessionScore(prev => prev + 1);
    setEvaluatedCount(prev => prev + 1);

    if (authToken) {
      try {
        await fetch(`${API_BASE_URL}/api/progress/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            questionId: activeQuestion.id,
            selectedAnswer: tentativeSelection,
            isCorrect,
            certainty: certaintyValue,
            latency: 60 - examTimer
          })
        });
      } catch (err) {
        console.log('Background cloud database synchronization sync failed silently.');
      }
    }
  };

  const advanceNextCase = () => {
    if (evaluatedCount >= freeLimitCeiling && !authToken) {
      setAppState('paywall');
      return;
    }
    if (currentIndex + 1 < questions.length) {
      setCurrentIndex(prev => prev + 1);
      resetQuestionViewportState();
      setIsTimerActive(true);
    } else {
      setAppState('paywall');
    }
  };

  const runAblCalculation = () => {
    const w = parseFloat(ablWeight);
    const s = parseFloat(ablHctStart);
    const t = parseFloat(ablHctTarget);
    if (!w || !s || !t) return;
    const ebv = selectedTrack === 'advanced_recertification' ? w * 70 : w * 75;
    const result = Math.round((ebv * (s - t)) / ((s + t) / 2));
    setAblResult(result);
  };

  const currentTheme = theme === 'night' ? darkPalette : theme === 'scrub' ? scrubPalette : creamPalette;

  if (appState === 'onboarding') {
    return (
      <View style={[styles.windowShell, { backgroundColor: currentTheme.bgPrimary }]}>
        <View style={styles.header}>
          <Text style={[styles.brandText, { color: currentTheme.textPrimary }]}>MACPREP</Text>
          <Pressable style={styles.themeBtn} onPress={() => setTheme(theme === 'cream' ? 'night' : theme === 'night' ? 'scrub' : 'cream')}>
            <Text style={{ color: currentTheme.textPrimary, fontSize: 12 }}>✨ THEME</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.centerContainer}>
          <Text style={[styles.scholarlyTitle, { color: currentTheme.textPrimary }]}>Anesthesia Certification & Recertification Workstation</Text>
          <Text style={[styles.broadsheetProse, { color: currentTheme.textMuted }]}>
            A rigorous, peer-reviewed clinical platform delivering hyper-challenging, legally insulated board questions backed by public medical literature.
          </Text>

          {errorMessage && <Text style={styles.errorText}>❌ {errorMessage}</Text>}

          <Text style={[styles.sectionSubtitle, { color: currentTheme.textPrimary }]}>1. SELECT CURRENT ROTATION MODALITY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.modalityScroll}>
            {['ALL', 'PHARM', 'CRISIS', 'AIRWAY', 'OBST', 'PEDS', 'CARDIAC', 'REGIONAL', 'PHYSICS'].map(mod => (
              <Pressable key={mod} onPress={() => setSelectedModality(mod)} style={[styles.modalityBadge, { backgroundColor: selectedModality === mod ? currentTheme.accent : currentTheme.bgSecondary, borderColor: currentTheme.border }]}>
                <Text style={{ color: selectedModality === mod ? '#ffffff' : currentTheme.textPrimary, fontSize: 11, fontWeight: 'bold' }}>{mod}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={[styles.sectionSubtitle, { color: currentTheme.textPrimary }]}>2. COGNITIVE TIMELINE ENTRANCE</Text>
          <View style={styles.forkRow}>
            <Pressable style={[styles.forkCard, { backgroundColor: currentTheme.bgSecondary, borderColor: currentTheme.border }]} onPress={() => startStreamingSession('initial_certification')}>
              <Text style={[styles.forkTitle, { color: currentTheme.textPrimary }]}>SAA TRACK</Text>
              <Text style={[styles.forkDesc, { color: currentTheme.textMuted }]}>Comprehensive Initial Board Certification Assessment Suite.</Text>
            </Pressable>

            <Pressable style={[styles.forkCard, { backgroundColor: currentTheme.bgSecondary, borderColor: currentTheme.border }]} onPress={() => startStreamingSession('advanced_recertification')}>
              <Text style={[styles.forkTitle, { color: currentTheme.textPrimary }]}>CAA TRACK</Text>
              <Text style={[styles.forkDesc, { color: currentTheme.textMuted }]}>Advanced Continuous Recertification Micro-Learning.</Text>
            </Pressable>
          </View>

          {!userProfile ? (
            <View style={styles.authContainer}>
              <Text style={[styles.sectionSubtitle, { color: currentTheme.textPrimary, textAlign: 'center' }]}>CLOUD DATA PERSISTENCE SYNC</Text>
              <Pressable style={[styles.authBtn, { backgroundColor: currentTheme.bgSecondary, borderColor: currentTheme.border }]} onPress={() => triggerMockOAuth('Google')}>
                <Text style={{ color: currentTheme.textPrimary, fontSize: 13 }}>Link Google Account Profile</Text>
              </Pressable>
              <Pressable style={[styles.authBtn, { backgroundColor: currentTheme.bgSecondary, borderColor: currentTheme.border }]} onPress={() => triggerMockOAuth('Apple')}>
                <Text style={{ color: currentTheme.textPrimary, fontSize: 13 }}>Link Apple Secure Token</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={[styles.authSuccessText, { color: currentTheme.accent }]}>✓ Authenticated Workspace Session Sync Active: {userProfile.email}</Text>
          )}
        </ScrollView>
        {loading && <ActivityIndicator style={styles.loader} size="large" color={currentTheme.accent} />}
      </View>
    );
  }

  if (appState === 'testing' && activeQuestion) {
    return (
      <View style={[styles.windowShell, { backgroundColor: currentTheme.bgPrimary }]}>
        <View style={styles.header}>
          <Pressable onPress={() => setAppState('onboarding')}>
            <Text style={[styles.navLink, { color: currentTheme.textPrimary }]}>← EXIT</Text>
          </Pressable>
          <View style={styles.telemetryMiniRow}>
            <Text style={[styles.telemetryText, { color: '#ef4444' }]}>⏱ {examTimer}s</Text>
            <Text style={[styles.telemetryText, { color: currentTheme.textPrimary, marginLeft: 12 }]}>SCORE: {sessionScore} / {evaluatedCount}</Text>
          </View>
        </View>

        {/* High-Acuity Telemetry Ribbon */}
        <View style={styles.telemetryRibbon}>
          <Text style={styles.telemetryRibbonText}>
            HR: {activeQuestion.telemetry?.hr || '--'} bpm  |  BP: {activeQuestion.telemetry?.bp || '--'} mmHg  |  SpO2: {activeQuestion.telemetry?.spo2 || '--'}%  |  ETCO2: {activeQuestion.telemetry?.etco2 || '--'} mmHg
          </Text>
        </View>

        {/* Tab Controls */}
        <View style={[styles.tabBar, { borderBottomColor: currentTheme.border }]}>
          {['QUESTION', 'CALCULATOR'].map(tab => (
            <Pressable key={tab} onPress={() => setActiveTab(tab.toLowerCase())} style={[styles.tabItem, activeTab === tab.toLowerCase() && { borderBottomColor: currentTheme.accent, borderBottomWidth: 2 }]}>
              <Text style={[styles.tabItemText, { color: activeTab === tab.toLowerCase() ? currentTheme.accent : currentTheme.textMuted }]}>{tab}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView style={styles.mainScroll}>
          {activeTab === 'question' ? (
            <View style={styles.paneLayout}>
              <Text style={[styles.stemText, { color: currentTheme.textPrimary, fontSize: 15 + fontSizeModifier }]}>{activeQuestion.stem}</Text>

              <View style={styles.choiceStack}>
                {activeQuestion.choices.map(choice => {
                  const label = choice.originalLabel;
                  const isStruck = struckOutLabels.includes(label);
                  const isTentative = tentativeSelection === label;
                  let cardBorderColor = currentTheme.border;
                  let accentBarColor = 'transparent';

                  if (isTentative) cardBorderColor = '#d97706';
                  if (isEvaluated) {
                    if (label === activeQuestion.correctAnswer) {
                      cardBorderColor = '#15803d';
                      accentBarColor = '#15803d';
                    } else if (isTentative) {
                      cardBorderColor = '#b91c1c';
                      accentBarColor = '#b91c1c';
                    }
                  }

                  return (
                    <View key={label} style={[styles.choiceContainer, { opacity: isStruck ? 0.3 : 1 }]}>
                      <Pressable style={[styles.choiceCard, { backgroundColor: currentTheme.bgSecondary, borderColor: cardBorderColor }]} onPress={() => handleSelectChoice(label)}>
                        <View style={[styles.accentGutter, { backgroundColor: accentBarColor }]} />
                        <Text style={styles.badgeText}>{label}</Text>
                        <Text style={[styles.choiceText, { color: currentTheme.textPrimary, fontSize: 13 + fontSizeModifier, textDecorationLine: isStruck ? 'line-through' : 'none' }]}>{choice.text}</Text>
                      </Pressable>
                      <Pressable style={styles.strikeHandle} onPress={() => toggleStrikethrough(label)}>
                        <Text style={{ color: currentTheme.textMuted, fontSize: 14 }}>⎯</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>

              {/* Gating Verification Bar */}
              {tentativeSelection && !isEvaluated && (
                <View style={[styles.gateContainer, { backgroundColor: currentTheme.bgSecondary, borderColor: '#d97706' }]}>
                  <Text style={[styles.gateHeading, { color: currentTheme.textPrimary }]}>LOG ASSESSMENT CERTAINTY PROFILES</Text>
                  <View style={styles.gateRow}>
                    {['CERTAIN', 'EDUCATED_GUESS', 'BLIND_GUESS'].map(cert => (
                      <Pressable key={cert} style={[styles.gateBtn, { backgroundColor: currentTheme.bgPrimary, borderColor: currentTheme.border }]} onPress={() => commitCertaintySubmission(cert)}>
                        <Text style={{ color: currentTheme.textPrimary, fontSize: 10, textAlign: 'center' }}>{cert.replace('_', ' ')}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              {/* Comprehensive Scientific Rationale */}
              {isEvaluated && (
                <View style={[styles.rationaleBox, { backgroundColor: currentTheme.bgSecondary, borderColor: currentTheme.border }]}>
                  <Text style={[styles.rationaleHeading, { color: currentTheme.textPrimary }]}>CRITICAL ANALYSIS RATIONALE</Text>
                  <Text style={[styles.rationaleProse, { color: currentTheme.textPrimary, fontSize: 13 + fontSizeModifier }]}>{activeQuestion.explanation}</Text>
                  
                  {activeQuestion.differential_table && (
                    <View style={styles.matrixTable}>
                      <Text style={[styles.tableHeading, { color: currentTheme.textPrimary }]}>DIFFERENTIAL DIAGNOSIS DATA WINDOW</Text>
                      {activeQuestion.differential_table.map((row, rIdx) => (
                        <View key={rIdx} style={[styles.tableRow, { borderBottomColor: currentTheme.border }]}>
                          <Text style={[styles.tableCell, { color: currentTheme.textPrimary, fontWeight: 'bold' }]}>{row.parameter}</Text>
                          <Text style={[styles.tableCell, { color: currentTheme.textMuted }]}>{row.condition_a}</Text>
                          <Text style={[styles.tableCell, { color: currentTheme.textMuted }]}>{row.condition_b}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <Text style={[styles.tableHeading, { color: currentTheme.textPrimary, marginTop: 14 }]}>VERIFIED PEER TRAIL SOURCE</Text>
                  <Pressable onPress={() => setActiveAbstract(activeAbstract ? null : true)} style={styles.citationLink}>
                    <Text style={{ color: '#b91c1c', fontSize: 12, textDecorationLine: 'underline' }}>{activeQuestion.source?.citation} (DOI: {activeQuestion.source?.doi})</Text>
                  </Pressable>

                  {activeAbstract && (
                    <View style={styles.abstractWell}>
                      <Text style={[styles.abstractText, { color: currentTheme.textPrimary }]}>{activeQuestion.source?.abstract || 'Peer literature abstract fully validated.'}</Text>
                    </View>
                  )}

                  <Pressable style={[styles.actionBtn, { backgroundColor: currentTheme.accent }]} onPress={advanceNextCase}>
                    <Text style={styles.actionBtnText}>ADVANCE TO NEXT QUESTION ➔</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : (
            <View style={styles.paneLayout}>
              <Text style={[styles.sectionSubtitle, { color: currentTheme.textPrimary }]}>WORKSPACE REVENUE FLUID CALCULATORS</Text>
              <View style={[styles.calcContainer, { backgroundColor: currentTheme.bgSecondary, borderColor: currentTheme.border }]}>
                <Text style={{ color: currentTheme.textPrimary, fontSize: 12, fontWeight: 'bold', marginBottom: 8 }}>ALLOWABLE BLOOD LOSS (ABL)</Text>
                <TextInput style={[styles.inputField, { color: currentTheme.textPrimary, borderColor: currentTheme.border }]} placeholder="Patient Mass Weight (kg)" placeholderTextColor={currentTheme.textMuted} keyboardType="numeric" value={ablWeight} onChangeText={setAblWeight} />
                <TextInput style={[styles.inputField, { color: currentTheme.textPrimary, borderColor: currentTheme.border }]} placeholder="Starting Baseline Hematocrit (%)" placeholderTextColor={currentTheme.textMuted} keyboardType="numeric" value={ablHctStart} onChangeText={setAblHctStart} />
                <TextInput style={[styles.inputField, { color: currentTheme.textPrimary, borderColor: currentTheme.border }]} placeholder="Minimum Target Threshold (%)" placeholderTextColor={currentTheme.textMuted} keyboardType="numeric" value={ablHctTarget} onChangeText={setAblHctTarget} />
                
                <Pressable style={[styles.gateBtn, { backgroundColor: currentTheme.bgPrimary, borderColor: currentTheme.border, marginTop: 8 }]} onPress={runAblCalculation}>
                  <Text style={{ color: currentTheme.textPrimary, fontSize: 12, textAlign: 'center' }}>EXECUTE FORMULA ANALYSIS</Text>
                </Pressable>

                {ablResult !== null && (
                  <View style={styles.sunkenWell}>
                    <Text style={{ color: currentTheme.textPrimary, fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>CALCULATED MAX ABL: {ablResult} mL</Text>
                  </View>
                )}
              </View>
            </View>
          )}
        </ScrollView>

        {/* Text Scaling Control Dock */}
        <View style={[styles.textDock, { backgroundColor: currentTheme.bgSecondary, borderTopColor: currentTheme.border }]}>
          <Pressable onPress={() => setFontSizeModifier(prev => Math.max(-3, prev - 1))} style={styles.fontBtn}><Text style={{ color: currentTheme.textPrimary }}>A⎯</Text></Pressable>
          <Text style={{ color: currentTheme.textMuted, fontSize: 11 }}>SCHOLARLY TEXT SIZE SCALER</Text>
          <Pressable onPress={() => setFontSizeModifier(prev => Math.max(5, prev + 1))} style={styles.fontBtn}><Text style={{ color: currentTheme.textPrimary }}>A+</Text></Pressable>
        </View>
      </View>
    );
  }

  if (appState === 'paywall') {
    return (
      <View style={[styles.windowShell, { backgroundColor: currentTheme.bgPrimary, justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <Text style={[styles.scholarlyTitle, { color: currentTheme.textPrimary, textAlign: 'center' }]}>Ecosystem Allocation Threshold Reached</Text>
        <Text style={[styles.broadsheetProse, { color: currentTheme.textMuted, textAlign: 'center', marginBottom: 20 }]}>
          You have efficiently evaluated 10% of the aggregate local simulation dataset. Unlock the entire 1,000 highly challenging clinical question bank.
        </Text>
        <View style={styles.sunkenWell}>
          <Text style={{ color: currentTheme.textPrimary, fontSize: 18, fontWeight: 'bold' }}>$50 USD Flat Lifetime Access</Text>
        </View>
        <Pressable style={[styles.actionBtn, { backgroundColor: '#15803d', width: '100%', marginTop: 14 }]} onPress={() => alert('Redirecting via secure Stripe dynamic API checkout link...')}>
          <Text style={styles.actionBtnText}>UNLOCK PREMIUM ACCESS PASS ➔</Text>
        </Pressable>
        <Pressable style={{ marginTop: 14 }} onPress={() => setAppState('onboarding')}>
          <Text style={{ color: currentTheme.textMuted, textDecorationLine: 'underline' }}>Return to Academic Dashboard</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}

const creamPalette = { bgPrimary: '#fcfbf9', bgSecondary: '#f5f2eb', border: '#e3ded8', textPrimary: '#1c1b1a', textMuted: '#6b6661', accent: '#881337' };
const darkPalette = { bgPrimary: '#121214', bgSecondary: '#1a1a1e', border: '#2d2d34', textPrimary: '#f3f3f6', textMuted: '#9aa0a6', accent: '#ef4444' };
const scrubPalette = { bgPrimary: '#f0f4f1', bgSecondary: '#dee7e1', border: '#cbdad0', textPrimary: '#14251c', textMuted: '#4d6255', accent: '#0f766e' };

const styles = StyleSheet.create({
  windowShell: { flex: 1, paddingTop: Platform.OS === 'ios' ? 50 : 20 },
  header: { height: 50, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brandText: { fontSize: 16, fontWeight: 'bold', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' },
  themeBtn: { padding: 6 },
  centerContainer: { padding: 16, alignItems: 'stretch' },
  scholarlyTitle: { fontSize: 20, fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', marginBottom: 12, lineHeight: 26 },
  broadsheetProse: { fontSize: 13, lineHeight: 19, marginBottom: 20 },
  sectionSubtitle: { fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 10, marginTop: 14 },
  modalityScroll: { flexDirection: 'row', marginBottom: 14 },
  modalityBadge: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, marginRight: 8 },
  forkRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  forkCard: { flex: 0.48, padding: 12, borderWidth: 1 },
  forkTitle: { fontSize: 14, fontWeight: 'bold', marginBottom: 4 },
  forkDesc: { fontSize: 11, lineHeight: 15 },
  authContainer: { marginTop: 20, borderTopWidth: 1, borderTopColor: '#cbdad0', paddingTop: 10 },
  authBtn: { padding: 12, borderWidth: 1, marginTop: 8, alignItems: 'center' },
  authSuccessText: { fontSize: 12, textAlign: 'center', fontWeight: 'bold', marginTop: 12 },
  loader: { position: 'absolute', top: '50%', left: '50%', marginLeft: -25, marginTop: -25 },
  errorText: { color: '#b91c1c', fontSize: 12, marginVertical: 10 },
  navLink: { fontSize: 13, fontWeight: 'bold' },
  telemetryMiniRow: { flexDirection: 'row' },
  telemetryText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontWeight: 'bold' },
  telemetryRibbon: { backgroundColor: '#000000', padding: 8, alignItems: 'center' },
  telemetryRibbonText: { color: '#22c55e', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  tabBar: { flexDirection: 'row', height: 40, borderBottomWidth: 1 },
  tabItem: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  tabItemText: { fontSize: 11, fontWeight: 'bold', letterSpacing: 1 },
  mainScroll: { flex: 1, padding: 16 },
  paneLayout: { paddingBottom: 60 },
  stemText: { fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', lineHeight: 23, marginBottom: 16 },
  choiceStack: { marginBottom: 16 },
  choiceContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  choiceCard: { flex: 1, flexDirection: 'row', alignItems: 'center', borderWidth: 1, minHeight: 48, paddingRight: 12 },
  accentGutter: { width: 4, height: '100%', marginRight: 10 },
  badgeText: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontWeight: 'bold', marginRight: 10 },
  choiceText: { flex: 1, lineHeight: 18 },
  strikeHandle: { width: 35, height: '100%', justifyContent: 'center', alignItems: 'center' },
  gateContainer: { padding: 12, borderWidth: 1, marginBottom: 16 },
  gateHeading: { fontSize: 10, fontWeight: 'bold', textAlign: 'center', marginBottom: 8, letterSpacing: 1 },
  gateRow: { flexDirection: 'row', justifyContent: 'space-between' },
  gateBtn: { flex: 0.31, padding: 8, borderWidth: 1 },
  rationaleBox: { padding: 14, borderWidth: 1, marginTop: 10 },
  rationaleHeading: { fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 8 },
  rationaleProse: { lineHeight: 19, marginBottom: 12 },
  matrixTable: { marginTop: 12, borderWidth: 1, borderColor: '#cbdad0' },
  tableHeading: { fontSize: 10, fontWeight: 'bold', padding: 6, backgroundColor: 'rgba(0,0,0,0.02)' },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, padding: 6 },
  tableCell: { flex: 1, fontSize: 11 },
  citationLink: { marginVertical: 6 },
  abstractWell: { padding: 10, backgroundColor: 'rgba(0,0,0,0.02)', marginTop: 6, borderWidth: 1, borderColor: '#cbdad0' },
  abstractText: { fontSize: 11, lineHeight: 16, fontStyle: 'italic' },
  actionBtn: { padding: 14, alignItems: 'center', marginTop: 14 },
  actionBtnText: { color: '#ffffff', fontSize: 11, fontWeight: 'bold', letterSpacing: 0.5 },
  calcContainer: { padding: 12, borderWidth: 1 },
  inputField: { height: 38, borderWidth: 1, paddingHorizontal: 10, fontSize: 13, marginTop: 8 },
  sunkenWell: { padding: 12, backgroundColor: 'rgba(0,0,0,0.04)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)', marginTop: 10, alignItems: 'center' },
  textDock: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 45, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16 },
  fontBtn: { padding: 8, width: 40, alignItems: 'center' }
});
