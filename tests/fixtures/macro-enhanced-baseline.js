// Deterministic cases shared by server tests and the real-browser parity check.
export const enhanced = [
    ['{{sub}}/{{obj}}/{{poss}}/{{poss_p}}/{{ref}}', 'she/her/her/hers/herself'],
    ['{{Sub}}/{{Obj}}/{{charobj}}/{{Charobj}}/{{pverb::is::are}}', 'She/Her/him/Him/is'],
    ['{{me-obj}}/{{me-upper::hello}}/{{capitalize::hello}}', 'her/HELLO/Hello'],
    ['{{sum::1,2,3}}/{{eq::a::a}}/{{wordcount::two words}}', '6/true/2'],
    ['{{dateadd::2026-01-31::1::months}}/{{datediff::2026-01-01::2026-01-03}}', '2026-02-28/2'],
    ['{{switch::a::a=selected::default={{incvar::unused}}}}/{{getvar::unused}}', 'selected/'],
    ['{{freeze::once}}{{incvar::count}}{{/freeze}}/{{freeze::once}}{{incvar::count}}{{/freeze}}/{{getvar::count}}', '1/1/1'],
    ['{{rollonce::roll::1d1}}/{{rollonce::roll::1d1}}', '1/1'],
    ['{{setchatvar::score_b::2}}{{setchatvar::score_a::1}}{{foreachChatVar::score_::item}}{{.item}}={{.item_value}};{{/foreachChatVar}}', 'a=1;b=2;'],
    ['{{addchatvar::score_a::2}}{{chatvarexists::score_a}}/{{getchatvar::score_a}}{{flushchatvar::score_a}}/{{haschatvar::score_a}}', 'true/3/false'],
    ['{{setpronouns::they/them}}{{obj}}/{{pverb::is::are}}{{setcharpronouns::she/her}}/{{charobj}}', 'them/are/her'],
];
