import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from collections import Counter
import study_protocol as protocol
import study_server as server


class StimuliTests(unittest.TestCase):
    def test_fixed_sa_bank_does_not_change_with_seed(self):
        source = {s['bank_id']:s for s in protocol.load_sa_bank()['cases']}
        positions = []
        for seed in [0, 1, 416, 2026]:
            deck = protocol.build_deck(seed)
            sa = [s for s in deck if s['purpose']=='sa']
            self.assertEqual({s['bank_id'] for s in sa}, set(source))
            for item in sa:
                fixed = source[item['bank_id']]
                self.assertEqual({k:v for k,v in item.items() if k!='id'}, fixed)
                self.assertIn(item['event']['kind'], ('deadline','none'))
            positions.append([s['bank_id'] for s in sa])
        self.assertGreater(len({tuple(x) for x in positions}),1)
        # Fixed question and answer-option positions must be identical in both UI conditions.
        self.assertEqual(len(protocol.sa_bank_metadata()['sa_bank_sha256']),64)
        for n in (1,2):
            correct_positions = Counter(next(i for i,o in enumerate(s['questions'][n]['options']) if o['id']==s['questions'][n]['correct']) for s in source.values())
            self.assertEqual(correct_positions, {0:3,1:3,2:3,3:3})
        for case in list(source.values())[:6]:
            q = case['questions'][2]
            self.assertEqual(q['subtype'],'recall')
            self.assertTrue(all(o['text'].endswith('분') for o in q['options']))

    def test_allocation_ground_truth_and_determinism(self):
        for seed in [0, 1, 42, 416, 2026]:
            deck = protocol.build_deck(seed)
            self.assertEqual(len(deck), 40)
            self.assertEqual(deck, protocol.build_deck(seed))
            main = [s for s in deck if not s['practice']]
            counts = Counter((s['purpose'], s['kind']) for s in main)
            self.assertEqual(counts, {('sa','invalid'):6,('sa','valid_change'):4,('sa','no_change'):2,
                                      ('behavior','invalid'):12,('behavior','valid_change'):8,('behavior','no_change'):4})
            self.assertEqual(Counter(s['subtype'] for s in main if s['purpose']=='sa'), {'recall':6,'projection':6})
            for s in deck:
                self.assertIn(s['recommendation'], protocol.feasible_orders(**s['initial']))
                self.assertTrue(s['feasible_orders'])
                self.assertEqual(s['recommendation'] in s['feasible_orders'], s['kind']!='invalid')
                if s['kind']=='no_change':self.assertEqual(s['initial'],s['current'])
                else:
                    changes=sum(s['initial'][field][r]!=s['current'][field][r] for field in ['durations','deadlines'] for r in protocol.ROBOTS)
                    self.assertEqual(changes,1)
                if s['purpose']=='sa':
                    for q in s['questions']:
                        self.assertEqual(len(q['options']),4)
                        self.assertEqual(sum(o['id']==q['correct'] for o in q['options']),1)
                        self.assertEqual(len({o['text'] for o in q['options']}),4)
                    comprehension=s['questions'][1]
                    target=comprehension['target']
                    actual=protocol.outcomes(s['recommendation'],**s['current'])[target]
                    for option in comprehension['options']:
                        matches=(option['finish']==actual['finish'] and option['deadline']==s['current']['deadlines'][target])
                        self.assertEqual(matches,option['id']==comprehension['correct'])
                    q=s['questions'][2]
                    if q['subtype']=='projection':
                        old=protocol.outcomes(s['recommendation'],**s['current'])
                        other=protocol.outcomes(q['alternate_order'],**s['current'])
                        self.assertNotEqual(old[q['target']]['finish'],other[q['target']]['finish'])
                        self.assertEqual(q['correct'],str(other[q['target']]['finish']))
                        self.assertEqual(q['alternate_order'].index(q['target']),1)

    def test_deadline_equality_and_example(self):
        p={'A':8,'B':4,'C':6}
        for b,expected in [(16,{'ABC','BAC'}),(6,{'BAC'}),(14,{'ABC','BAC'})]:
            self.assertEqual({''.join(x) for x in protocol.feasible_orders(p,{'A':13,'B':b,'C':20})},expected)
        self.assertEqual(protocol.outcomes(list('BAC'),p,{'A':12,'B':6,'C':20})['A']['overrun'],0)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.storage=patch.object(server,'DATA',Path(self.temp.name));self.storage.start()
        server.SESSIONS.clear()
        self.s=server.create_session({'participant':'TEST','mode':'demo','condition':'node','seed':416,
                                      'prelude_s':1,'review_s':1,'question_s':3,'decision_s':5})
        self.clock=10000
        self.n=0

    def tearDown(self):
        self.storage.stop();self.temp.cleanup();server.SESSIONS.clear()

    def action(self,name,**extra):
        self.n+=1
        data={'action':name,'request_id':f'request_{self.n:08d}','trial_id':self.s['active']['scenario_id'] if self.s['active'] else None,**extra}
        with patch('study_server.time.time',return_value=self.clock):return server.act(self.s,data)

    def reveal(self):
        self.clock+=3
        with patch('study_server.time.time',return_value=self.clock):return server.view(self.s)

    def test_english_demo_preserves_stimuli_and_scores(self):
        korean_deck = self.s["deck"]
        self.s = server.create_session({**self.s["config"], "language": "en"})
        self.assertEqual(server.view(self.s)["config"]["language"], "en")
        self.assertEqual(len(self.s["deck"]), len(korean_deck))
        self.action("start")
        for korean, english in zip(korean_deck, self.s["deck"]):
            for key in ("id", "initial", "current", "recommendation", "feasible_orders"):
                self.assertEqual(english[key], korean[key])
            public = self.reveal()
            if public["phase"] == "question":
                for index, (ko, en) in enumerate(zip(korean["questions"], english["questions"])):
                    self.assertEqual(en["correct"], ko["correct"])
                    self.assertEqual([o["id"] for o in en["options"]], [o["id"] for o in ko["options"]])
                    self.assertNotRegex(json.dumps(public["question"], ensure_ascii=False), "[가-힣]")
                    public = self.action("answer", question_index=index, answer=en["correct"])
            else:
                self.assertNotRegex(public["stimulus"]["event"]["text"], "[가-힣]")
                self.action("judge", judgment="keep" if english["valid"] else "change")
                self.action("confirm", order=english["feasible_orders"][0])
            self.action("next")
        self.assertEqual(self.s["screen"], "survey")
        summary = server.aggregate(self.s)
        self.assertEqual(summary["sa_primary"], 1)
        self.assertEqual(summary["balanced_accuracy"], 1)
        with self.assertRaises(ValueError):
            server.validate_config({"participant": "TEST", "mode": "pilot", "language": "en"})

    def test_full_flow_resume_export_and_perfect_score(self):
        self.action('start')
        while self.s['screen']=='trial':
            public=self.reveal()
            if public['phase']=='question':
                self.assertNotIn('stimulus',public)
                self.assertNotIn('correct',public['question'])
                for i in range(3):
                    q=self.s['deck'][self.s['index']]['questions'][i]
                    public=self.action('answer',question_index=i,answer=q['correct'])
            else:
                s=self.s['deck'][self.s['index']]
                public=self.action('judge',judgment='keep' if s['valid'] else 'change')
                public=self.action('confirm',order=s['feasible_orders'][0])
            self.assertEqual(public['phase'],'trial_done')
            if not public['practice']:self.assertNotIn('practice_feedback',public)
            public=self.action('next')
        self.assertEqual(self.s['screen'],'survey')
        public=self.action('survey',tlx={k:50 for k in ['mental','physical','temporal','performance','effort','frustration']})
        self.assertEqual(public['phase'],'finished')
        self.assertEqual(public['summary']['sa_primary'],1)
        self.assertEqual(public['summary']['balanced_accuracy'],1)
        self.assertEqual(public['summary']['raw_tlx'],50)
        saved=json.loads((server.DATA/(self.s['id']+'.json')).read_text())
        self.assertEqual(saved['records'],self.s['records'])
        self.assertIn(b'balanced_accuracy',server.csv_payload(self.s,'summary'))
        self.assertIn(b'scenario_id',server.csv_payload(self.s,'answers'))
        self.assertIn(b'sa_bank_id',server.csv_payload(self.s,'answers'))
        self.assertIn(b'sa-fixed-ko-v2',server.csv_payload(self.s,'summary'))

    def test_old_session_preserves_version_and_new_assignment_is_separate(self):
        self.s['version']='ie416-2026-11-03-v1'
        self.s.pop('sa_bank_version',None);self.s.pop('sa_bank_sha256',None)
        public=server.view(self.s)
        self.assertTrue(public['legacy_protocol'])
        self.assertEqual(public['protocol_version'],self.s['version'])
        self.assertEqual(server.aggregate(self.s)['protocol_version'],self.s['version'])
        server.save(self.s)
        with patch('study_server.secrets.choice',return_value='node') as choice:
            new=server.create_session({'participant':'NEW','mode':'demo','condition':'auto'})
        self.assertEqual(set(choice.call_args.args[0]),{'table','node'})
        self.assertEqual(new['version'],protocol.VERSION)

    def test_duplicate_request_does_not_advance_twice(self):
        self.action('start');self.reveal()
        s=self.s['deck'][0]
        data={'action':'judge','request_id':'duplicate_request','trial_id':s['id'],'judgment':'change'}
        with patch('study_server.time.time',return_value=self.clock):
            server.act(self.s,data);count=len(self.s['events']);server.act(self.s,data)
        self.assertEqual(count,len(self.s['events']))

    def test_early_answer_and_invalid_permutation_rejected(self):
        self.action('start')
        with self.assertRaises(ValueError):self.action('judge',judgment='keep')
        self.reveal();self.action('judge',judgment='change')
        with self.assertRaises(ValueError):self.action('confirm',order=['A','A','B'])

    def test_timeout_and_missing_judgment_not_counted_as_specificity(self):
        self.action('start');self.clock+=20
        with patch('study_server.time.time',return_value=self.clock):public=server.view(self.s)
        self.assertEqual(public['phase'],'trial_done')
        self.assertTrue(self.s['records'][0]['timeout'])
        self.assertEqual(server.aggregate(self.s)['missing_judgments'],1)
        self.assertIsNone(server.aggregate(self.s)['balanced_accuracy'])

    def test_prelude_and_ui_payload_hide_labels_and_key(self):
        public=self.action('start')
        self.assertEqual(public['phase'],'prelude')
        self.assertIsNone(public['stimulus']['event'])
        self.assertNotIn('valid',public)
        self.assertNotIn('purpose',public)
        self.assertNotIn('feasible_orders',public['stimulus'])

    def test_config_validation(self):
        for bad in [{'participant':'../name'},{'participant':'A','review_s':float('nan')},
                    {'participant':'A','mode':'main','review_s':1},{'participant':'A','condition':'invalid'}]:
            with self.assertRaises(ValueError):server.validate_config(bad)

    def test_full_36_trials_practice_and_breaks(self):
        self.s=server.create_session({'participant':'FULL_TEST','mode':'pilot','condition':'table'})
        self.action('start');breaks=[]
        while self.s['screen'] not in ('survey','finished'):
            if self.s['screen']=='break':
                breaks.append(sum(not r['practice'] for r in self.s['records']))
                self.action('continue')
            a=self.s['active'];self.clock=a['review_end']+.05
            with patch('study_server.time.time',return_value=self.clock):public=server.view(self.s)
            s=self.s['deck'][self.s['index']]
            if s['purpose']=='sa':
                for i,q in enumerate(s['questions']):self.action('answer',question_index=i,answer=q['correct'])
            else:
                self.action('judge',judgment='keep' if s['valid'] else 'change')
                self.action('confirm',order=s['feasible_orders'][0])
            self.action('next')
        result=server.aggregate(self.s)
        self.assertEqual(breaks,[12,24])
        self.assertEqual(len(self.s['records']),40)
        self.assertEqual(result['completed_main'],36)
        self.assertEqual(result['invalid_denominator'],12)
        self.assertEqual(result['valid_denominator'],12)
        self.assertEqual(result['sa_primary'],1)
        self.assertEqual({r['sa_bank_id'] for r in self.s['records'] if r['purpose']=='sa'}, {f'S{i:02d}' for i in range(1,13)})


if __name__=='__main__':unittest.main()
