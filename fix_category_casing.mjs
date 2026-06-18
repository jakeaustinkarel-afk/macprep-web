import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function healCategoryCasing() {
  console.log("🩺 Initializing Case-Healing Data Fixer...");
  
  try {
    const { data: questions, error } = await supabase.from('questions').select('id, specialty');
    if (error) throw error;

    console.log(`📡 Inspecting formatting properties across ${questions.length} indices...`);
    let updatedCount = 0;

    for (const q of questions) {
      if (q.specialty && q.specialty !== q.specialty.toUpperCase()) {
        const upperSpecialty = q.specialty.toUpperCase().trim();
        
        const { error: updateError } = await supabase
          .from('questions')
          .update({ specialty: upperSpecialty })
          .eq('id', q.id);

        if (updateError) console.error(`❌ Failed to update row ID ${q.id}`);
        else updatedCount++;
      }
    }

    console.log(`\n🏆 Success! Formatted and repaired ${updatedCount} mixed-case fields into pure UPPERCASE keys.`);
  } catch (err) {
    console.error("❌ Diagnostic Script Failure:", err.message);
  }
}

healCategoryCasing();
