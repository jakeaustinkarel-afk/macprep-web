import React, { useState } from 'react';
import { StyleSheet, Text, View, ActivityIndicator, TouchableOpacity, ScrollView, SafeAreaView } from 'react-native';
import { useQuestions } from './src/hooks/useQuestions';

export default function App() {
  const { questions, loading, error, refetch } = useQuestions();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  if (loading) return <View style={[styles.container, styles.center]}><ActivityIndicator size="large" color="#38bdf8" /><Text style={styles.text}>Calibrating Mission Array...</Text></View>;
  if (error || questions.length === 0) return <View style={[styles.container, styles.center]}><Text style={styles.error}>❌ Handshake Severed</Text><TouchableOpacity style={styles.btn} onPress={refetch}><Text style={styles.btnText}>Retry Sync</Text></TouchableOpacity></View>;

  const q = questions[currentIndex];
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}><Text style={styles.logo}>MACPrep Mobile</Text><Text style={styles.badge}>{q.difficulty || 'BOARD LEVEL'}</Text></View>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text style={styles.tag}>{q.modality || 'General'}</Text>
        <Text style={styles.stem}>{q.stem}</Text>
        <View style={{ gap: 12, marginBottom: 30 }}>
          {(q.choices || []).map((choice, i) => {
            const l = String.fromCharCode(65 + i);
            return (
              <TouchableOpacity key={i} style={[styles.card, selected === l && styles.cardSel]} onPress={() => setSelected(l)}>
                <View style={[styles.pill, selected === l && styles.pillSel]}><Text style={{ color: selected === l ? '#0a0e17' : '#38bdf8', fontWeight: '700' }}>{l}</Text></View>
                <Text style={{ color: '#f1f5f9', flex: 1 }}>{choice}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', gap: 15 }}>
          <TouchableOpacity style={[styles.nav, currentIndex === 0 && { opacity: 0.3 }]} disabled={currentIndex === 0} onPress={() => { setCurrentIndex(currentIndex - 1); setSelected(null); }}><Text style={styles.navText}>Previous</Text></TouchableOpacity>
          <TouchableOpacity style={styles.nav} onPress={() => { if (currentIndex < questions.length - 1) { setCurrentIndex(currentIndex + 1); setSelected(null); } else { alert("Block Complete!"); } }}><Text style={styles.navText}>{currentIndex === questions.length - 1 ? "Finish" : "Next"}</Text></TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e17' },
  center: { justifyContent: 'center', alignItems: 'center' },
  text: { color: '#94a3b8', marginTop: 15, fontWeight: '500' },
  error: { color: '#ef4444', marginBottom: 15, fontWeight: '700' },
  btn: { borderWidth: 1, borderColor: '#38bdf8', padding: 12, borderRadius: 6 },
  btnText: { color: '#38bdf8', fontWeight: '700' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#222f47' },
  logo: { fontSize: 18, fontWeight: '800', color: '#fff' },
  badge: { fontSize: 10, color: '#f59e0b', borderWidth: 1, borderColor: '#f59e0b', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, fontWeight: '700' },
  tag: { color: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)', alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, fontSize: 12, fontWeight: '700', marginBottom: 15 },
  stem: { color: '#fff', fontSize: 16, lineHeight: 24, marginBottom: 25, fontWeight: '500' },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#121826', borderWidth: 1, borderColor: '#222f47', padding: 14, borderRadius: 8 },
  cardSel: { borderColor: '#00ff88' },
  pill: { width: 30, height: 30, backgroundColor: '#1a2336', justifyContent: 'center', alignItems: 'center', borderRadius: 4, marginRight: 12 },
  pillSel: { backgroundColor: '#00ff88' },
  nav: { flex: 1, borderWidth: 1, borderColor: '#38bdf8', padding: 14, borderRadius: 6, alignItems: 'center' },
  navText: { color: '#38bdf8', fontWeight: '700' }
});
