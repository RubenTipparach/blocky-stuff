// A catalogue of building styles from many cultures and times (owner, 2026-10-27: "Add in various culture architecture
// styles too, ... with different time periods (I'm expecting a rich catalogue of over 100 building styles and types)").
// Each is told in the blocks this game has (Minetest Game): what the walls are made of, the accents, the roof (a
// build_roof shape, its pitch and stairs), and the features that make it recognisable. The characters look styles up
// with browse_styles (server/tools.mjs), and are offered a few they have not built lately when they plan a project.
//
// One line each: name | culture or region | period | kind of building | walls | accents | roof | features.
// The roof is "<shape> [pitch] <stairs>", with shapes as build_roof has them.

const RAW = `
Neolithic roundhouse | Prehistoric Britain | c. 3000 BC | house | default:cobble low wall, default:wood above | default:tree posts | cone steep stairs:stair_straw | round plan, farming:straw thatch down to head height, a central hearth, one low door
Stone Age longhouse | Neolithic Europe | c. 5000 BC | hall | default:wood | default:tree posts in rows | gable steep stairs:stair_straw | long and narrow, posts down the middle, thatch nearly to the ground, animals at one end
Mud-brick house | Ancient Mesopotamia | c. 3000 BC | house | default:desert_sandstone_brick | default:desert_stone | flat stairs:stair_desert_sandstone_brick | flat roof terrace reached by a ladder, small high windows, a courtyard
Ziggurat | Sumer, Babylon | c. 2100 BC | temple | default:desert_sandstone_brick | default:desert_stonebrick | flat stairs:stair_desert_sandstone_brick | stepped terraces of shrinking squares, a long front stairway, a shrine on top
Egyptian pyramid | Old Kingdom Egypt | c. 2500 BC | tomb | default:sandstone_block | default:goldblock capstone | pyramid stairs:stair_sandstone_block | square base aligned north, smooth sloping faces, a gold tip, a hidden entrance passage
Egyptian temple | New Kingdom Egypt | c. 1300 BC | temple | default:sandstonebrick | default:sandstone columns, wool:blue and wool:yellow paint | flat stairs:stair_sandstonebrick | massive pylon gateway with sloped sides, a hall of thick columns, obelisks of sandstone_block flanking the entry
Egyptian mastaba | Early Dynastic Egypt | c. 2900 BC | tomb | default:sandstone_block | default:desert_stone | flat stairs:stair_sandstone_block | low rectangular bench shape with sloping walls, a false door niche
Minoan palace | Bronze Age Crete | c. 1700 BC | palace | default:sandstonebrick | wool:red columns (wider at top), wool:blue bands | flat stairs:stair_sandstone | many rooms round a central court, light wells, red columns, grand stairs
Mycenaean citadel | Bronze Age Greece | c. 1300 BC | fortress | default:cobble huge blocks | default:stone_block lintel | castle stairs:stair_cobble | cyclopean walls of big rough stone, a lion gate with a triangle over the lintel, a megaron hall inside
Greek Doric temple | Classical Greece | c. 450 BC | temple | default:silver_sandstone_block | default:silver_sandstone columns | gable low stairs:stair_silver_sandstone_block | a ring of plain columns on a three-step base, a triangular pediment, no windows
Greek Ionic temple | Classical Greece | c. 420 BC | temple | default:silver_sandstone_brick | default:silver_sandstone_block columns, slab capitals | gable low stairs:stair_silver_sandstone_brick | slender columns with scroll capitals (slabs either side), a frieze band, a porch of columns
Greek stoa | Classical Greece | c. 400 BC | market hall | default:silver_sandstone_block | default:silver_sandstone columns | shed low stairs:stair_silver_sandstone_block | a long covered walkway open on one side with a colonnade, shops at the back
Greek amphitheatre | Classical Greece | c. 350 BC | theatre | default:silver_sandstone_brick | default:stone_block | none (open air) stairs:stair_silver_sandstone_brick | a half circle of stepped stone seats cut into a hillside, a round stage below
Roman domus | Ancient Rome | c. 50 BC | house | default:brick, default:silver_sandstone plaster | wool:red and wool:yellow bands | hip low stairs:stair_brick | rooms round an atrium with a rain pool (default:water_source) under an opening in the roof, a garden peristyle at the back
Roman insula | Ancient Rome | c. 100 AD | apartments | default:brick | default:stone_block | hip low stairs:stair_brick | four or five storeys, shops with wide openings at street level, small balconies
Roman temple | Ancient Rome | c. 20 BC | temple | default:silver_sandstone_block | default:silver_sandstone columns | gable low stairs:stair_silver_sandstone_block | on a tall podium with front stairs only, a deep porch of columns, a pediment
Pantheon | Ancient Rome | c. 125 AD | temple | default:stone_block | default:silver_sandstone columns | dome default:stone_block | a round hall under a huge dome with an open oculus at the top, a columned porch with a pediment
Roman bathhouse | Ancient Rome | c. 200 AD | baths | default:brick | default:stone_block arches | dome low default:brick | big vaulted halls, pools of water, an arched entrance, a furnace room below
Roman aqueduct | Ancient Rome | c. 50 AD | bridge | default:stone_block | default:stonebrick | none (a channel on top) stairs:stair_stone_block | tiers of tall round arches carrying a water channel (default:water_source) across a valley
Roman villa | Ancient Rome | c. 100 AD | villa | default:silver_sandstone_brick | default:brick trim, wool:red | hip low stairs:stair_brick | long colonnaded front, a courtyard garden, vineyards and fields round it
Roman watchtower | Roman frontier | c. 120 AD | tower | default:stonebrick | default:wood gallery | pyramid stairs:stair_wood | square stone tower, a wooden balcony round the top floor, a palisade fence round the base
Colosseum | Ancient Rome | c. 80 AD | arena | default:silver_sandstone_block | default:silver_sandstone columns between arches | none (open) stairs:stair_silver_sandstone_block | an oval of stacked arcades, four storeys, an arena floor of sand inside
Celtic hillfort | Iron Age Europe | c. 300 BC | fortress | default:dirt_with_grass ramparts | default:tree palisade | none | rings of earth banks and ditches round a hilltop, a log palisade, roundhouses inside
Viking longhouse | Norse Scandinavia | c. 900 AD | hall | default:pine_wood | default:pine_tree posts, carved gable ends | gable steep stairs:stair_pine_wood | long boat-shaped hall, crossed dragon-head beams at the gable tips, a turf roof option (default:dirt_with_grass), a central hearth
Norse stave church | Medieval Norway | c. 1150 | church | default:pine_wood | default:pine_tree staves, default:coalblock tar | gable steep stairs:stair_pine_wood | stacked steep roofs one above another, dragon heads on the gables, a covered walkway round it
Anglo-Saxon hall | Early medieval England | c. 700 | hall | default:wood | default:tree posts | gable steep stairs:stair_straw | timber hall with thatch, a door in the long side, a hearth and benches inside
Byzantine church | Byzantine Empire | c. 540 | church | default:brick | default:stone_block bands, default:goldblock inside | dome low default:brick | a central dome on a square, half domes round it, mosaic gold inside, arched windows in a ring under the dome
Russian Orthodox church | Medieval Russia | c. 1500 | church | default:silver_sandstone_brick white | wool:blue, wool:green or default:goldblock domes | cone steep stairs:stair_silver_sandstone_brick | onion domes on drums (dome over a narrower ring), several domes, tall slender bell tower
Romanesque church | Medieval Europe | c. 1100 | church | default:stone_block | default:stonebrick round arches | gable stairs:stair_stone_block | thick walls, small round-arched windows, a square tower, a semicircular apse
Gothic cathedral | Medieval France | c. 1250 | cathedral | default:stone_block | default:stonebrick buttresses, default:glass and wool:blue/red stained glass | gable steep stairs:stair_stone_block | tall pointed arches, a rose window, flying buttresses, twin west towers with pyramid spires
Norman castle keep | Norman England | c. 1080 | castle | default:stonebrick | default:stone_block corners | castle default:stonebrick | a square keep three or four storeys high, a door up a stair on the first floor, slit windows, crenellations
Motte-and-bailey | Norman Europe | c. 1070 | castle | default:wood palisade | default:tree posts | pyramid stairs:stair_wood | a wooden tower on an earth mound, a fenced yard below with a ditch and a bridge
Concentric castle | Medieval Wales | c. 1290 | castle | default:stonebrick | default:cobble | castle default:stonebrick | two rings of walls, round towers with cone roofs at the corners, a gatehouse with a portcullis (xpanes:bar_flat), a moat
Medieval timber-frame house | Medieval England | c. 1450 | house | default:silver_sandstone plaster panels | default:tree beams, crossed braces | gable steep stairs:stair_wood | dark beams in a grid on white panels, an upper floor jettied out over the street, a brick chimney
Tudor manor | Tudor England | c. 1540 | manor | default:brick | default:tree beams, default:stone_block quoins | gable steep stairs:stair_stonebrick | half-timbered gables, tall clustered chimneys, big windows of many panes, an E-shaped plan
Medieval village cottage | Medieval Europe | c. 1300 | cottage | default:cobble | default:tree frame | gable steep stairs:stair_straw | small, one room, thatched, a vegetable plot and a fence, a well nearby
Medieval market hall | Medieval England | c. 1500 | market | default:wood upper floor | default:stone_block pillars | hip stairs:stair_wood | an open ground floor on stone pillars for the market, a meeting room above
Medieval mill | Medieval Europe | c. 1300 | mill | default:stonebrick | default:wood wheel | gable stairs:stair_wood | a water wheel of wood and fence on the side, beside a stream, a grain loft
Monastery cloister | Medieval Europe | c. 1200 | monastery | default:stone_block | default:stonebrick arches | shed stairs:stair_stone_block | a square garden ringed by an arcaded walkway, a chapel on one side, a herb garden
Italian Renaissance palazzo | Florence | c. 1450 | palace | default:stone_block rusticated base, default:silver_sandstone_brick above | slab cornices | hip low stairs:stair_stone_block | three tall storeys, rows of round-arched windows, a heavy cornice, a courtyard inside
Renaissance villa | Venetian Italy | c. 1570 | villa | default:silver_sandstone_brick | default:silver_sandstone columns | hip low stairs:stair_brick | symmetrical, a temple-front porch on each side, a central dome
Baroque church | Rome | c. 1650 | church | default:silver_sandstone_block | default:goldblock accents | dome stairs:stair_silver_sandstone_block | a curving facade, paired columns, a big dome with a lantern, statues on the skyline
Baroque palace | France | c. 1680 | palace | default:silver_sandstone_brick | default:goldblock trims, default:stone_block | hip low stairs:stair_stonebrick | very long symmetrical wings, tall windows, formal gardens with hedges (default:bush_leaves) and fountains
French chateau | Loire Valley | c. 1520 | chateau | default:silver_sandstone_block | default:stone_block | cone steep stairs:stair_obsidian_block | round towers with tall dark cone roofs, dormer windows, a moat and a bridge
Dutch canal house | Amsterdam | c. 1650 | townhouse | default:brick | default:silver_sandstone trim | gable steep stairs:stair_brick | tall and narrow, a stepped or bell-shaped gable to the street, a hoist beam at the top, big windows
Flemish guildhall | Flanders | c. 1500 | guildhall | default:brick | default:stone_block, default:goldblock | gable steep stairs:stair_brick | a stepped gable, a tall belfry tower, rich carved stone front
German half-timbered house | Germany | c. 1550 | house | default:silver_sandstone plaster | default:tree beams in patterns | gable steep stairs:stair_brick | decorative beam patterns, upper storeys stepping out, window boxes of flowers
Swiss chalet | Alps | c. 1700 | chalet | default:pine_wood | default:pine_tree, default:stone_block base | gable low stairs:stair_pine_wood | wide low roof with deep eaves, balconies with carved fences, a stone ground floor, flower boxes
Alpine hut | Alps | c. 1800 | hut | default:pine_tree logs | default:cobble base | gable stairs:stair_pine_wood | stones on the roof, a woodpile, small windows with shutters
Scottish tower house | Scotland | c. 1500 | tower | default:cobble harled | default:stone_block | gable steep stairs:stair_stone_block | a tall narrow tower, corbelled turrets with cone roofs at the corners, crow-stepped gables
Irish thatched cottage | Ireland | c. 1800 | cottage | default:silver_sandstone white walls | wool:red door and window frames | gable stairs:stair_straw | long and low, thick thatch, a half door, a turf fire chimney
Spanish Moorish palace | Al-Andalus | c. 1350 | palace | default:sandstonebrick | default:silver_sandstone_block, wool:blue tile bands | flat stairs:stair_sandstonebrick | courtyards with long pools and fountains, horseshoe arches, patterned tiles, slender columns
Spanish hacienda | Colonial Mexico | c. 1750 | ranch | default:silver_sandstone plaster | default:acacia_tree beams | hip low stairs:stair_brick | white walls, red tile roof, a courtyard with a fountain, arched porch, wooden balconies
Portuguese azulejo house | Lisbon | c. 1800 | townhouse | wool:blue and wool:white tile facade | default:silver_sandstone trim | hip low stairs:stair_brick | facades of blue patterned tiles, iron balconies (xpanes:bar_flat), tall shutters
Georgian townhouse | Britain | c. 1760 | townhouse | default:brick | default:silver_sandstone trim | hip low stairs:stair_obsidian_block | strict symmetry, sash windows in rows, a fanlight over the door, railings at the front
Victorian terraced house | Britain | c. 1880 | townhouse | default:brick | default:stone_block bay windows | gable steep stairs:stair_obsidian_block | a bay window, a small front garden with railings, chimneys on the party walls
Victorian Gothic mansion | Britain | c. 1870 | mansion | default:brick | default:stone_block, default:obsidian_glass | gable steep stairs:stair_obsidian_block | pointed windows, a tower with a steep pyramid roof, iron cresting, a conservatory of glass
Industrial warehouse | Britain | c. 1860 | warehouse | default:brick | default:steelblock frames | gable low stairs:stair_steelblock | huge rows of arched windows, loading doors on every floor, a chimney stack
Industrial mill | Lancashire | c. 1850 | factory | default:brick | default:stone_block | shed stairs:stair_steelblock | saw-tooth roof of repeated sheds, a tall round chimney, a water tower
Railway station | Victorian Britain | c. 1870 | station | default:brick | default:steelblock, default:glass | gable low stairs:stair_glass | a long glass and iron train shed, a clock tower, platforms with rails (carts:rail)
Lighthouse | Atlantic coasts | c. 1850 | lighthouse | default:silver_sandstone_brick | wool:red bands | cone stairs:stair_steelblock | a round tapering tower, red and white stripes, a glass lantern room with default:meselamp at the top, a keeper's cottage
New England saltbox | Colonial America | c. 1700 | house | default:wood shingles | default:tree frame | gable steep stairs:stair_wood | two storeys at front, one at back, the long roof sloping down behind, a big central chimney
American colonial | Colonial America | c. 1750 | house | default:brick | default:silver_sandstone trim | gable stairs:stair_obsidian_block | symmetrical, a centered door with a pediment, chimneys at both ends, dormers
Log cabin | American frontier | c. 1820 | cabin | default:tree logs | default:cobble chimney | gable stairs:stair_wood | one or two rooms, a stone chimney at one end, a porch, a woodpile and a fence
Western saloon | American West | c. 1880 | saloon | default:wood | default:pine_wood | flat stairs:stair_wood | a tall false front hiding the roof, a covered boardwalk, swinging doors, a balcony
Barn | Rural America | c. 1900 | barn | default:wood with wool:red | wool:white trim | gambrel stairs:stair_wood | a big gambrel roof, a hay loft door high in the gable, a silo beside it
Plantation house | American South | c. 1840 | mansion | default:silver_sandstone_brick white | default:silver_sandstone columns | hip stairs:stair_obsidian_block | two-storey columns across the whole front, wide verandas, tall shutters
Pueblo | Ancestral Puebloan | c. 1100 | village | default:desert_sandstone | default:acacia_tree vigas | flat stairs:stair_desert_sandstone | stacked terraced rooms entered by ladders, wooden beam ends sticking out, round kivas
Tipi camp | Great Plains | c. 1800 | tent | wool:white | default:tree poles | cone steep stairs:stair_wood | cone tents of hide (wool) on poles sticking out at the top, painted bands, a fire ring
Iroquois longhouse | Haudenosaunee | c. 1500 | hall | default:aspen_wood bark | default:aspen_tree | dome low default:aspen_wood | a long barrel-roofed bark house, doors at both ends, fires down the middle
Mayan step pyramid | Classic Maya | c. 700 | temple | default:stone_block | default:mossycobble | flat stairs:stair_stone_block | a steep pyramid of terraces, one huge stair to a temple on top with a tall roof comb
Aztec temple | Aztec Empire | c. 1450 | temple | default:stonebrick | wool:red and wool:blue shrines | flat stairs:stair_stonebrick | a twin stair pyramid with two shrines on top, a plaza in front
Inca stonework | Inca Empire | c. 1450 | house | default:stone_block tight-fitted | default:stonebrick | gable steep stairs:stair_straw | trapezoid doors and windows narrowing at the top, perfectly fitted stone, terraces on a mountainside
Moroccan riad | Morocco | c. 1700 | house | default:desert_sandstone_brick | wool:blue tiles, default:acacia_wood | flat stairs:stair_desert_sandstone_brick | inward-facing, a garden courtyard with a fountain and orange trees, few outer windows, a roof terrace
Arabian desert fort | Arabian Peninsula | c. 1800 | fortress | default:desert_sandstone | default:desert_stone | castle default:desert_sandstone | mud walls with round corner towers, tapered walls, a big wooden gate, crenellations
Persian iwan mosque | Safavid Persia | c. 1620 | mosque | default:sandstonebrick | wool:blue and wool:cyan tile, default:goldblock | dome steep default:sandstonebrick | a huge arched portal (iwan), a turquoise dome on a tall drum, slender minarets
Ottoman mosque | Ottoman Empire | c. 1560 | mosque | default:silver_sandstone_block | default:obsidian_block domes | dome low default:silver_sandstone_block | a great central dome with cascading half domes, four needle minarets with cone tops, a courtyard
Mughal mausoleum | Mughal India | c. 1640 | tomb | default:silver_sandstone_block white | default:sandstonebrick inlay | dome steep default:silver_sandstone_block | a bulbous dome on a drum, four minarets at the corners, a long reflecting pool, gardens in four parts
Rajput fort palace | Rajasthan | c. 1600 | palace | default:sandstonebrick | default:desert_stonebrick | dome low default:sandstonebrick | massive walls on a hill, small domed pavilions (chhatris) on pillars, latticed windows (xpanes)
Hindu Nagara temple | Northern India | c. 1000 | temple | default:sandstonebrick | default:sandstone_block carvings | cone steep stairs:stair_sandstonebrick | a tall curved tower (shikhara) over the shrine, a porch hall, a raised platform
Dravidian temple | Southern India | c. 1100 | temple | default:desert_sandstone_brick | wool:yellow, wool:red, wool:blue | pyramid steep stairs:stair_desert_sandstone_brick | a towering stepped gateway (gopuram), crowded with colour, a temple tank of water
Buddhist stupa | Ancient India, Sri Lanka | c. 200 BC | shrine | default:silver_sandstone_brick | default:goldblock spire | dome default:silver_sandstone_brick | a solid dome on a square base, a stone fence round it with four gateways, a spire on top
Tibetan monastery | Tibet | c. 1600 | monastery | default:silver_sandstone white | wool:red top band, default:goldblock roof | flat stairs:stair_silver_sandstone | tapering whitewashed walls on a mountainside, a red band under a gold roof, prayer flags (wool)
Nepali pagoda | Kathmandu Valley | c. 1700 | temple | default:brick | default:junglewood carved struts | pyramid stairs:stair_junglewood | three or more stacked roofs, carved wooden struts, a brick base with steps
Chinese courtyard house | Ming and Qing China | c. 1600 | house | default:brick grey | wool:red columns and doors | gable low stairs:stair_obsidian_block | four buildings round a courtyard, a red gate, upturned eaves, a screen wall inside the gate
Chinese pagoda | Tang to Song China | c. 1050 | tower | default:brick | wool:red columns, default:junglewood | pyramid stairs:stair_obsidian_block | octagonal or square, many storeys each with its own roof, bells at the eaves corners
Chinese imperial hall | Forbidden City | c. 1420 | palace | wool:red walls | default:goldblock, default:junglewood | hip stairs:stair_goldblock | on a white stone terrace (default:silver_sandstone_block) with stairs, red columns, a double golden hip roof
Chinese garden pavilion | Suzhou | c. 1600 | pavilion | default:junglewood columns | wool:red, default:obsidian_glass | pyramid stairs:stair_obsidian_block | open on all sides, upswept eaves, by a pond with stepping stones and a zigzag bridge
Great Wall section | Ming China | c. 1550 | wall | default:stonebrick | default:brick | castle default:stonebrick | a thick wall following the ridges, a walkway with crenellations, square watchtowers every so often
Tulou | Hakka China | c. 1700 | village | default:dirt rammed earth | default:junglewood galleries | dome low stairs:stair_brick | a huge round building of earth, wooden galleries round a courtyard, one gate
Japanese minka | Edo Japan | c. 1700 | farmhouse | default:wood | default:tree posts | gable steep stairs:stair_straw | a deep thatched roof, sliding paper doors (wool:white panes), an earth-floored kitchen, a raised floor
Japanese shrine | Shinto Japan | c. 800 | shrine | default:wood | wool:red torii gate | gable stairs:stair_wood | a red torii gate in front, a raised hall with crossed rafters at the ridge, gravel paths, lanterns
Japanese temple | Buddhist Japan | c. 750 | temple | default:wood | wool:red posts | hip stairs:stair_obsidian_block | wide hip roofs with curved eaves, a five-storey pagoda nearby, a gate with guardian figures
Japanese castle | Sengoku Japan | c. 1600 | castle | default:silver_sandstone white | default:obsidian_block base, default:obsidian | hip steep stairs:stair_obsidian_block | a sloping stone base, a white keep of stacked roofs, gables on each level, a moat
Japanese tea house | Japan | c. 1600 | tea house | default:wood | default:tree | gable stairs:stair_straw | tiny, a low crawl-through door, a garden path of stepping stones, a stone lantern
Korean hanok | Joseon Korea | c. 1700 | house | default:wood | default:silver_sandstone walls | hip stairs:stair_obsidian_block | gently curved roof, a raised wooden floor, a courtyard, a stone wall round it
Khmer temple | Angkor, Cambodia | c. 1150 | temple | default:sandstone_block | default:mossycobble | pyramid steep stairs:stair_sandstone_block | five lotus-bud towers in a quincunx, galleries round them, a moat, carved reliefs
Thai temple | Siam | c. 1800 | temple | default:silver_sandstone white | default:goldblock, wool:red, wool:green | gable steep stairs:stair_goldblock | stacked steep roofs with gold finials, a golden spire (cone), gilded gables
Javanese candi | Java | c. 850 | temple | default:stone_block | default:mossycobble | pyramid stairs:stair_stone_block | a terraced mountain of stone with bell-shaped stupas on the top terraces
Malay stilt house | Malaysia | c. 1850 | house | default:junglewood | default:jungletree stilts | gable steep stairs:stair_junglewood | raised on stilts, a ladder up, wide windows, carved gable ends
Polynesian fale | Samoa | c. 1800 | house | default:junglewood posts | farming:straw | dome stairs:stair_straw | open sides, a round thatched roof on posts, a stone platform, no walls
Maori meeting house | New Zealand | c. 1850 | hall | default:junglewood | wool:red carvings | gable stairs:stair_junglewood | a carved red gable front with sloping bargeboards, a figure at the peak, a porch
Great Zimbabwe enclosure | Southern Africa | c. 1300 | enclosure | default:stone_block dry-stone | default:stonebrick chevrons | none | curving tall stone walls without mortar, a conical stone tower inside, chevron patterns
Sahelian mud mosque | Mali | c. 1300 | mosque | default:dirt | default:tree beams sticking out | flat stairs:stair_desert_sandstone | massive earth walls with buttresses, wooden beams poking out, conical towers
Ethiopian rock church | Lalibela | c. 1200 | church | default:desert_stone carved | default:desert_stonebrick | flat stairs:stair_desert_stone | carved down into the rock in a cross shape, a trench round it, windows cut in the rock
Zulu beehive hut | Southern Africa | c. 1800 | hut | farming:straw | default:tree frame | dome steep farming:straw | a dome of thatch to the ground, a low door, huts in a ring round a cattle pen
Swahili coral house | East African coast | c. 1700 | house | default:coral_skeleton | default:junglewood carved door | flat stairs:stair_silver_sandstone | coral stone walls, a richly carved wooden door, a roof terrace, narrow lanes
Nubian vaulted house | Nubia | c. 1900 | house | default:desert_sandstone | wool:blue and wool:white patterns | dome low default:desert_sandstone | vaulted roofs, painted geometric patterns round the doors, a courtyard
Inuit igloo | Arctic | c. 1800 | shelter | default:snowblock | default:ice window | dome default:snowblock | a dome of snow blocks, a low tunnel entrance, an ice window, furs inside
Sami lavvu | Lapland | c. 1800 | tent | wool:grey | default:pine_tree poles | cone steep stairs:stair_pine_wood | a cone tent, a reindeer pen, a raised storehouse on a post
Mongolian ger | Mongolia | c. 1800 | tent | wool:white felt | wool:red door, default:wood | dome low wool:white | round felt tent with a lattice wall, a red painted door facing south, a crown opening at the top
Silk Road caravanserai | Central Asia | c. 1300 | inn | default:sandstonebrick | wool:blue tiles | flat stairs:stair_sandstonebrick | a square fortified courtyard inn, one big arched gate, rooms round a court with a well
Armenian monastery | Armenia | c. 1000 | church | default:stone_block | default:stonebrick | cone stairs:stair_stone_block | a cross plan, a drum with a cone roof at the centre, carved cross-stones (khachkars)
Georgian Svan tower | Caucasus | c. 1100 | tower | default:cobble | default:stone_block | gable stairs:stair_cobble | slender defensive stone towers in a mountain village, five storeys, a small roof
Art Nouveau house | Brussels, Paris | c. 1900 | townhouse | default:silver_sandstone_brick | default:steelblock curves, default:glass | hip stairs:stair_copperblock | flowing curves, iron balconies, a big round window, copper roof details
Gaudi-esque villa | Barcelona | c. 1905 | house | wool:cyan, wool:yellow, wool:white mosaic | default:sandstonebrick | dome low default:sandstonebrick | wavy walls, colourful mosaic, bone-like columns, a twisting chimney
Art Deco skyscraper | New York | c. 1930 | tower | default:silver_sandstone_block | default:goldblock, default:steelblock | pyramid steep stairs:stair_steelblock | setbacks stepping in as it rises, a shining spire, vertical stripes of windows
Prairie house | American Midwest | c. 1910 | house | default:brick | default:wood bands | hip low stairs:stair_wood | long and low, deep overhanging eaves, bands of windows, a central chimney
Bauhaus | Germany | c. 1926 | house | default:silver_sandstone_block white | default:glass, default:steelblock | flat stairs:stair_silver_sandstone_block | white cubes, flat roofs, bands of windows, no decoration, a roof terrace
Modernist villa | France | c. 1930 | house | default:silver_sandstone_block white | default:glass | flat stairs:stair_silver_sandstone_block | raised on thin pillars, a long ribbon window, a free plan, a roof garden
Brutalist block | Britain | c. 1965 | apartments | default:stone_block | default:obsidian_glass | flat stairs:stair_stone_block | massive raw concrete, repeated deep windows, walkways in the sky
Mid-century modern | California | c. 1955 | house | default:wood | default:glass, default:stone_block | shed low stairs:stair_wood | open plan, walls of glass to the garden, a low slanted roof, a pool
Soviet constructivist | Soviet Union | c. 1928 | club | default:stone_block | wool:red | flat stairs:stair_stone_block | bold geometric blocks, a cylinder and a slab, big signs, glass stair towers
Glass skyscraper | Global | c. 1960 | tower | default:glass | default:steelblock grid | flat stairs:stair_steelblock | a curtain wall of glass in a steel grid, a plaza at the foot, meselamps lit at night
High-tech building | Global | c. 1980 | museum | default:glass | default:steelblock pipes outside | flat stairs:stair_steelblock | the structure and pipes on the outside in bright colours (wool), glass walls
Deconstructivist museum | Global | c. 1997 | museum | default:steelblock | default:tinblock, default:glass | shed stairs:stair_tinblock | twisted, tilted shapes clashing, shining metal skin
Eco house | Global | c. 2010 | house | default:wood | default:glass, default:dirt_with_grass roof | shed low stairs:stair_wood | a green roof of grass, solar panels (default:obsidian_glass) on the slope, big south windows, a rain barrel
Cyberpunk tower | Imagined future | 2077 | tower | default:obsidian_block | default:mese, wool:magenta, wool:cyan, default:meselamp | flat stairs:stair_obsidian_block | stacked mismatched blocks, glowing signs, cables, walkways between towers
Space colony dome | Imagined future | 2150 | habitat | default:glass dome | default:steelblock ring | dome default:glass | a big glass dome over gardens, airlock entrances, a landing pad
Elven tree house | Fantasy | ageless | house | default:aspen_wood | default:aspen_tree, default:leaves | cone steep stairs:stair_aspen_wood | built round and up a great tree, spiral stairs, curved balconies, lanterns
Dwarven mountain hall | Fantasy | ageless | hall | default:stonebrick | default:goldblock, default:stone_block | none (inside a mountain) stairs:stair_stonebrick | carved into a cliff, a huge square doorway with runes, pillars, forges glowing (default:lava_source behind glass)
Wizard tower | Fantasy | ageless | tower | default:stonebrick | default:obsidian_glass, wool:violet | cone steep stairs:stair_obsidian_block | a tall crooked round tower, a pointed cone roof with a star (default:mese) at the tip, a spiral stair
Hobbit hole | Fantasy | ageless | house | default:dirt_with_grass hillside | wool:green round door, default:wood | none (inside a hill) stairs:stair_wood | dug into a grassy hill, a round green door, round windows, a garden and a fence
Witch's cottage | Folklore | ageless | cottage | default:mossycobble | default:tree crooked beams | gable steep stairs:stair_straw | lopsided, a crooked chimney, herbs drying, a cauldron, mushrooms in the garden
Pirate cove | Golden Age of Piracy | c. 1700 | hideout | default:wood | default:tree, default:fence_wood | shed stairs:stair_wood | stilted shacks over the water, docks, a lookout crow's nest, barrels and crates (default:chest)
Treehouse village | Fantasy | ageless | village | default:junglewood | default:jungletree, default:ladder_wood | pyramid stairs:stair_junglewood | platforms high in the jungle trees, rope bridges (default:fence_junglewood rails), ladders
Floating sky island | Fantasy | ageless | island | default:dirt_with_grass | default:stone underside, default:water_source falls | none | a chunk of land in the sky with a cottage, a waterfall falling off the edge, a bridge to the next island
Steampunk workshop | Imagined Victorian | c. 1890 | workshop | default:brick | default:copperblock, default:bronzeblock pipes | gable stairs:stair_copperblock | copper pipes and gears, a tall chimney, a glass skylight, an airship mooring mast
Desert oasis town | Sahara | c. 1500 | village | default:desert_sandstone | default:acacia_wood, wool:white awnings | flat stairs:stair_desert_sandstone | flat-roofed houses round a pool with palms, market stalls with cloth awnings, a well
Fishing village | North Atlantic | c. 1900 | village | default:wood with wool:red, wool:yellow, wool:blue | wool:white trim | gable steep stairs:stair_wood | brightly painted wooden houses on the shore, a pier, boats, drying racks
Hilltop monastery | Greece, Meteora | c. 1400 | monastery | default:stonebrick | wool:red | hip stairs:stair_brick | perched on a rock pillar, reached by a long stair or ladder, a small domed church
Venetian palazzo | Venice | c. 1450 | palace | wool:pink or default:brick | default:silver_sandstone tracery | flat stairs:stair_silver_sandstone | pointed arch windows in rows, a water gate on the canal, mooring poles striped in wool
Medieval bridge with houses | Medieval Europe | c. 1300 | bridge | default:stone_block arches | default:tree beams | gable steep stairs:stair_wood | stone arches over a river with timber houses built along the bridge, a gate tower at one end
Windmill | Netherlands | c. 1700 | mill | default:brick or default:wood | wool:white sails | cone stairs:stair_wood | a tapering tower, four big sails of fence and wool, a gallery round the middle
Water tower | Industrial America | c. 1920 | tower | default:steelblock tank | default:tree legs | cone low stairs:stair_steelblock | a round tank on tall legs with crossed braces, a ladder, a cone cap
Lunar observatory | Modern | c. 1950 | observatory | default:silver_sandstone_block | default:steelblock | dome default:steelblock | a white round building with a silver dome and a slot opening, on a mountaintop
`;

const ERA_YEAR = (era) => {
  const m = /(-?\d{3,4})\s*(BC|AD)?/i.exec(era ?? '');
  if (!m) return null;
  const y = Number(m[1]);
  return /BC/i.test(m[2] ?? '') ? -y : y;
};

/** The styles, parsed: { id, name, region, era, year, type, walls, accents, roof, features }. */
export const STYLES = RAW.trim().split('\n').map((line, i) => {
  const [name, region, era, type, walls, accents, roof, features] = line.split('|').map((s) => s.trim());
  return { id: i + 1, name, region, era, year: ERA_YEAR(era), type, walls, accents, roof, features };
});

/** A style in a few lines, for a character. */
export const styleText = (s) => `#${s.id} ${s.name} (${s.region}, ${s.era}; ${s.type}). Walls: ${s.walls}. Accents: ${s.accents}. `
  + `Roof: ${s.roof}. Features: ${s.features}.`;

/**
 * Styles matching words (all of them, anywhere: name, region, era, type, features), or a kind of building; or random
 * ones, leaving out the names in `avoid`. Returns at most `count`.
 */
export function findStyles({ words = '', type = '', count = 6, random = false, avoid = [], rnd = Math.random } = {}) {
  const ws = String(words).toLowerCase().split(/\s+/).filter(Boolean);
  const skip = new Set(avoid.map((a) => String(a).toLowerCase()));
  let list = STYLES.filter((s) => !skip.has(s.name.toLowerCase()))
    .filter((s) => !type || s.type.toLowerCase().includes(String(type).toLowerCase()))
    .filter((s) => ws.every((w) => `${s.name} ${s.region} ${s.era} ${s.type} ${s.features} ${s.walls}`.toLowerCase().includes(w)));
  if (random) list = list.map((s) => [rnd(), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  return list.slice(0, Math.max(1, Math.min(12, count)));
}
