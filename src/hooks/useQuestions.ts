import { useState, useEffect } from 'react';

export interface Question {
  id: string;
  modality: string;
  difficulty: string;
  stem: string;
  choices: string[];
  correct_answer: string;
  explanation: string;
}

export const useQuestions = () => {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQuestions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('https://macprep-workstation.onrender.com/api/questions');
      if (!response.ok) throw new Error(`Server status code: ${response.status}`);
      const data = await response.json();
      if (data.questions && data.questions.length > 0) {
        setQuestions(data.questions);
      } else {
        throw new Error("Empty cloud dataset returned.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to establish cloud handshake.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchQuestions(); }, []);
  return { questions, loading, error, refetch: fetchQuestions };
};
