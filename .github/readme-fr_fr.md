<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Dernière version : **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. Le développement continue sur `staging`.

**Autres langues :** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Ceci est une traduction du [README anglais](../README.md). Si les deux ne disent pas la même chose, c'est la version anglaise qui est à jour.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - L'interface de RP pour LLM la plus mignonne">
</p>

> [!NOTE]
> Tout le code ici est généré par un LLM ou écrit avec l'aide d'un LLM, mais tous les prompts et tous les agents livrés avec Neconyan sont écrits par des humains.

Neconyan, c'est mon fork félin de [SillyTavern](https://github.com/SillyTavern/SillyTavern) et de [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), pour discuter et faire du jeu de rôle avec des personnages IA, sur ordinateur comme sur téléphone. Le modèle, c'est à toi de l'apporter, via un backend local ou une clé API : aucun accès à un modèle ni aucun crédit n'est fourni.

**[Lis le manuel officiel de Neconyan](https://platberlitz.github.io/neconyan-docs/).** Commence par là pour l'installation et pour toutes tes questions sur l'utilisation de Neconyan. Tu y trouveras des guides illustrés de captures d'écran, une référence des macros et des instructions pour créer des extensions. Si quelque chose ne marche pas, jette un œil au [guide de dépannage](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) avant d'ouvrir un ticket.

Si tu veux un SillyTavern où tout fonctionne exactement comme dans le projet d'origine, utilise plutôt [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Je ne reprends du projet d'origine que ce qui m'intéresse, donc certaines choses n'ont pas le même aspect ni le même comportement ici, et certaines extensions risquent de ne pas fonctionner.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Pourquoi Neconyan ?">
</p>

- **Il continue quand tu t'en vas.** Les réponses s'écrivent dans le navigateur sous tes yeux, parce que c'est plus rapide. Si tu changes d'appli ou que tu verrouilles ton téléphone au milieu d'une discussion en tête-à-tête, le serveur garde la réponse et te la remet quand tu rouvres cette discussion, sans que tu la paies deux fois. Conversation, Meower et la gestion de la mémoire continuent de toute façon sur le serveur. Si tu veux que les Agents qui passent après une réponse continuent eux aussi, règle « Where replies are written » sur **On the server**. Quelques fonctions ont encore besoin que la page reste ouverte, comme les modèles WebLLM qui tournent dans le navigateur et les voix Kokoro.
- **Il est vraiment fait pour le téléphone.** De vrais onglets avec des intitulés, une barre de discussion en bas de l'écran et un menu coulissant, pas la mise en page pour ordinateur rétrécie tant bien que mal.
- **Quatre façons de discuter.** Le Jeu de rôle classique, Conversation façon messagerie, un fil social appelé Meower, et le Mode histoire pour les textes longs.
- **Une mémoire pour ton histoire.** [Mewmory](../docs/mewmory.md) garde la trace de ton histoire, des PNJ que tu as croisés et de ce qu'ils t'ont dit, pour que tu n'aies pas à tout réexpliquer 200 messages plus tard.
- **Les bons outils sont déjà inclus.** Agents, Archive de chat, Quick Image Gen, Guided Generations, BotSearcher et quelques autres, chacun avec ses propres réglages. [Voici ceux qui ont commencé comme des projets à part, et qui les a créés.](../docs/neconyan-native-tools.md)
- **Un endroit pour tes notes.** Les [Carnets](../docs/notebooks.md) te donnent de la place pour tes brouillons de personnages, tes lieux, tes plans de scènes et tes journaux de session, juste à côté de tes discussions. Les notes peuvent être liées entre elles et à tes lorebooks, et les assistants peuvent les modifier si tu les y autorises.
- **De petits assistants.** Miso, Taro et Nori peuvent utiliser des appels d'outils pour créer des personnages avec leur portrait, modifier des lorebooks et ajuster des préréglages ou des agents. La courte visite « Premières pattes » te montre les bases, et le [Simple Mode](#simple-mode) met les fonctions avancées de côté jusqu'à ce que tu en aies envie.
- **Quelqu'un avec qui parler de ton histoire.** Le [Scratchpad](../docs/scratchpad.md) est une discussion annexe, à côté de ton histoire, où les assistants, tes propres personnages ou toute une table ronde réunissant plusieurs d'entre eux peuvent lire la scène et te donner des idées, sans que rien de tout ça ne finisse dans la discussion principale.
- **C'est mignon.** Des thèmes Calico, des chats qui font la sieste sur tes messages et un chat en pixel art sur l'Accueil. C'était un peu tout l'intérêt, en fait.
- **Tes fichiers restent les tiens.** Il lit les mêmes cartes de personnage, discussions, lorebooks et préréglages que SillyTavern, et il n'y a aucune télémétrie.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modes">
</p>

Ce sont des discussions, des notes et des réponses du Scratchpad mises en scène pour la démo avec les assistants inclus, alors n'en tire pas trop de conclusions.

### Accueil

C'est là que tu arrives. Choisis un personnage, lance un chat temporaire, connecte un modèle ou dis bonjour à l'un des assistants.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="L'Accueil sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="L'Accueil sur un téléphone"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Il y a beaucoup de boutons ici, et tu n'as pas besoin de la plupart d'entre eux dès le premier jour. Le Simple Mode range Mewmory, l'Archive de chat, les Extensions, le sélecteur de mode, la plupart des Réglages fins et les boutons supplémentaires autour de la zone de message, et ne te laisse que les personnages, les connexions, les préréglages, les lorebooks, les Agents, les Carnets et le Scratchpad. Nori te demande si tu le veux avant le début de la visite « Premières pattes ». Rien n'est désactivé, c'est seulement masqué : appuie sur **Show all features** dans la barre latérale ou désactive-le dans Paramètres > Apparence dès que tu veux tout retrouver.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Une discussion en Jeu de rôle avec le Simple Mode activé, sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Une discussion en Jeu de rôle avec le Simple Mode activé, sur un téléphone"></td>
  </tr>
</table>

### Jeu de rôle

La discussion classique telle que tu la connais dans SillyTavern, avec un chat endormi sur tes messages.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Le Jeu de rôle sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Le Jeu de rôle sur un téléphone"></td>
  </tr>
</table>

### Conversation

Tu écris à tes personnages comme tu écrirais à un ami. Il y a une liste de Pals, des discussions de groupe, des branches, et des personnages qui peuvent être occupés ou hors ligne.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Conversation sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Conversation sur un téléphone"></td>
  </tr>
</table>

### Meower

Un mini fil social où tes personnages publient, se répondent entre eux et lancent des sondages sur les en-cas.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower sur un téléphone"></td>
  </tr>
</table>

### Mode histoire

La discussion transformée en prose continue, pour les moments où tu préfères lire une histoire plutôt que faire défiler des bulles.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Le Mode histoire sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Le Mode histoire sur un téléphone"></td>
  </tr>
</table>

### Carnets

Un carnet qui vit à côté de tes discussions, pour les brouillons de personnages et les plans de scènes que tu perdrais sinon quelque part dans un fichier texte. Il propose des modèles, des dossiers, des propriétés et un mode lecture, et tu peux l'ouvrir à côté d'une discussion. [En savoir plus sur les Carnets.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Les Carnets sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Les Carnets sur un téléphone"></td>
  </tr>
</table>

### Scratchpad

Une discussion annexe, posée à côté de ton histoire, pour les moments où tu veux parler de la scène sans que les personnages t'entendent. Demande à Miso, Taro ou Nori, copie une de tes cartes de personnage ou crée ton propre assistant, puis installe jusqu'à trois d'entre eux autour d'une table ronde et laisse-les se disputer pour savoir si ton coup de théâtre fait mouche. Rien de ce que tu écris là-bas n'entre dans l'histoire. [En savoir plus sur le Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Le Scratchpad à côté d'une discussion en Mode histoire, sur ordinateur"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Le Scratchpad sur un téléphone"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Bien démarrer">
</p>

Choisis ce qui correspond à ce que tu as :

| Tu as | Opte pour |
| --- | --- |
| Un téléphone sous Android 11 ou plus récent | [L'application Android](#android-app) |
| Un téléphone Android plus ancien, ou tu aimes bien le terminal | [Termux](#android-with-termux) |
| Windows, macOS ou Linux | [Une installation sur ordinateur](#on-a-computer) |
| Un iPhone sous iOS 17 ou plus récent, et le sideloading ne te dérange pas | [L'application iPhone](#iphone-app) |
| N'importe quel autre iPhone, ou tu préfères garder tes discussions sur un ordinateur | Une installation sur ordinateur, puis [l'ouvrir sur ton téléphone](#opening-it-on-your-phone) |

Quel que soit ton choix, il te faut quand même un modèle à qui parler : une clé API d'un fournisseur, ou un backend local comme KoboldCpp ou Ollama.

<a id="android-app"></a>

### Application Android

Sous Android 11 ou plus récent, télécharge le fichier qui se termine par `-android-arm64.apk` depuis la [dernière version](https://github.com/platberlitz/Neconyan/releases/latest) et ouvre-le. Android te demandera sans doute d'abord d'autoriser l'installation d'applications depuis ton navigateur.

Tout tourne sur le téléphone, donc pas besoin de Termux ni d'ordinateur. Garde environ 2 GiB d'espace libre et laisse à la première ouverture le temps de tout décompresser. Il faut aussi Android System WebView 124 ou plus récent, et l'application te prévient si le tien est trop ancien. Pour mettre à jour, installe le nouvel APK par-dessus l'ancien, et tes discussions restent en place. [Installation sur Android, sauvegardes et instructions de compilation.](../android/README.md)

<a id="iphone-app"></a>

### Application iPhone

Il existe désormais aussi une application iPhone autonome. Même principe que sur Android : le serveur, tes discussions et tes réglages vivent tous sur le téléphone, donc tu n'as pas besoin d'un ordinateur qui fait tourner Neconyan. Elle n'est pas sur l'App Store, c'est donc à toi de l'installer par sideloading.

1. Ouvre la [page de la version](https://github.com/platberlitz/Neconyan/releases/latest) et télécharge le fichier qui se termine par `-ios-unsigned.ipa`, si cette version en contient un. Sinon, passe plutôt par l'[installation via le navigateur](#opening-it-on-your-phone).
2. Sélectionne-le dans un outil de sideloading comme [iloader](https://github.com/nab138/iloader). L'outil le signe avec ton compte Apple et l'installe. Il te faut iOS 17 ou plus récent.
3. Ouvre Neconyan et connecte un modèle depuis **Connexions**, comme partout ailleurs.

Avec un compte Apple gratuit, il faut signer à nouveau l'application tous les sept jours, et tu ne peux installer que trois applications par sideloading. Pour mettre à jour, installe le nouvel IPA par-dessus l'ancien avec le même compte Apple, et tes discussions restent en place. Supprimer l'application supprime aussi tes discussions, alors exporte d'abord une sauvegarde de compte si tu changes d'outil de sideloading.

Les imports continuent quand tu changes d'appli ou que tu verrouilles le téléphone. Choisis la sauvegarde avec le bouton **Importer le ZIP de sauvegarde** de l'application elle-même, confirme, et le serveur prend le relais : il joue du silence pour qu'iOS ne le suspende pas pendant qu'il travaille, et tu peux revenir voir où il en est quand tu veux. Les réponses continuent aussi, comme dans un onglet de navigateur sur ordinateur : si tu quittes l'application au milieu d'une réponse, la page joue son propre son silencieux jusqu'à ce que la réponse soit écrite et enregistrée, et que les éventuels Agents qui passent après aient fini. Tu verras peut-être « Neconyan is finishing a reply » sur l'écran verrouillé pendant ce temps, et la musique d'une autre application peut se mettre en pause jusqu'à la fin. iOS peut quand même fermer l'application si le téléphone manque de mémoire. Garde environ deux fois la taille de la sauvegarde en espace libre pendant qu'elle est copiée. [Installation sur iPhone, limites et instructions de compilation.](../ios/README.md)

<a id="on-a-computer"></a>

### Sur un ordinateur

1. **Récupère Neconyan.** Il y a deux façons de faire, et la deuxième se tient à jour toute seule.

   - **Télécharge-le.** Prends le fichier qui se termine par `-source.zip` dans la [dernière version](https://github.com/platberlitz/Neconyan/releases/latest) et décompresse-le dans un endroit facile à retrouver, comme ton dossier Documents. Sous Windows, fais d'abord un clic droit sur le zip et choisis **Extraire tout**, car le lanceur ne fonctionne pas si tu l'exécutes depuis l'intérieur du zip. Tu obtiendras un dossier qui porte le nom de la version, comme `Neconyan-1.3.7`.
   - **Clone-le avec [Git](https://git-scm.com/downloads).** Ouvre un terminal là où tu veux mettre le dossier et lance la ligne ci-dessous. Le lanceur vérifie ensuite s'il y a une nouvelle version à chaque démarrage et se met à jour avant de s'ouvrir, et c'est pour ça que c'est la méthode que je choisirais.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Démarre-le.** Ouvre le dossier Neconyan et exécute le lanceur de ton système.

   | Système | Comment |
   | --- | --- |
   | Windows | Double-clique sur `Start.bat` |
   | macOS | Double-clique sur `Start.command` |
   | Linux ou WSL | Ouvre un terminal dans le dossier et lance `./start.sh` |

   Le premier démarrage prend quelques minutes. Si tu n'as ni Bun ni Node.js (les programmes qui font vraiment tourner Neconyan), le lanceur installe Bun pour toi, puis télécharge tout le reste dont Neconyan a besoin. Garde cette fenêtre ouverte tant que tu utilises Neconyan : si tu la fermes, ou si tu y appuies sur Ctrl+C, Neconyan s'arrête.

3. **Ouvre-le.** Ton navigateur devrait s'ouvrir tout seul. Sinon, va sur **http://127.0.0.1:4433/**.
4. **Connecte un modèle.** Clique sur **Connexions** dans la barre latérale, choisis ton fournisseur et ton modèle, puis colle ta clé API ou l'adresse de ton backend local. Ensuite, importe un personnage ou dis bonjour à Miso, Taro ou Nori sur l'Accueil.

La prochaine fois, relance le même lanceur.

**Mettre à jour.** Les installations Git se mettent à jour toutes seules au démarrage. Pour le zip, télécharge le nouveau et décompresse-le dans un nouveau dossier, ferme Neconyan, puis copie le dossier `data` de l'ancien dossier Neconyan dans le nouveau, ainsi que `config.yaml` si tu l'as modifié. Démarre la nouvelle version et vérifie que tes discussions sont bien là avant de supprimer l'ancien dossier.

<a id="android-with-termux"></a>

### Android avec Termux

[Termux](https://termux.dev/) est une application de terminal pour Android. C'est plus laborieux que l'application ci-dessus, mais ça marche aussi sur les téléphones plus anciens.

1. Installe Termux depuis [F-Droid](https://f-droid.org/packages/com.termux/) ou [ses versions publiées sur GitHub](https://github.com/termux/termux-app/releases).
2. Ouvre Termux et mets-le à jour. S'il s'arrête pour te poser une question sur un fichier de configuration, appuie sur Entrée pour garder celui que tu as.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Installe Git, puis télécharge Neconyan dans ton dossier personnel Termux. `--depth 1` laisse de côté l'ancien historique du projet : le téléchargement est plus léger, et les mises à jour fonctionnent quand même.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Démarre-le. Le premier démarrage installe Node.js et tout le reste dont Neconyan a besoin, alors laisse-lui quelques minutes.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Quand tu vois `Go to: http://127.0.0.1:4433/ to open Neconyan`, ouvre cette adresse dans Chrome ou dans n'importe quel autre navigateur du téléphone. Connecte ensuite un modèle depuis **Connexions**, comme sur ordinateur.

Quelques réflexes Termux à prendre :

- Pour arrêter Neconyan, appuie sur **CTRL** dans la rangée de touches supplémentaires, puis sur **C**.
- La prochaine fois, ouvre Termux et relance `cd ~/Neconyan && bash start.sh`. Il se met à jour tout seul avant de démarrer.
- Garde le dossier dans ton dossier personnel Termux. Le lanceur refuse de démarrer depuis le stockage partagé, comme `/sdcard`, parce qu'Android y bloque les liens de fichiers dont les paquets de Neconyan ont besoin.
- Dans le menu de Chrome, **Ajouter à l'écran d'accueil** donne à Neconyan sa propre icône.

**Le garder actif en arrière-plan.** Android aime bien arrêter les applications que tu ne regardes pas, et Termux ne fait pas exception. Ces étapes gardent Neconyan en vie pendant que tu es dans une autre application :

1. Déroule tes notifications et vérifie que celle de Termux indique que le wake lock est actif. Neconyan le demande au démarrage ; si ça n'a pas tenu, touche **Acquire wakelock** dans cette notification.
2. Ouvre **Paramètres → Applications → Termux → Batterie** sur Android et choisis **Unrestricted**. Les noms changent d'une marque de téléphone à l'autre, alors cherche « optimisation de la batterie » dans les Paramètres si tu ne trouves pas.
3. Depuis Android 12, Android tue aussi les processus supplémentaires lancés par Termux, et Neconyan en fait partie. À partir d'Android 14, active les Options pour les développeurs (touche sept fois **Numéro de build** dans **À propos du téléphone**), puis active **Disable child process restrictions**. Sous Android 12 et 13, il n'y a pas d'option pour ça, donc tu dois lancer ces deux commandes une seule fois depuis un ordinateur, avec `adb` et le débogage USB :

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Même quand le serveur reste en vie, Chrome peut quand même décharger la page au bout d'un moment, et Neconyan se recharge alors quand tu reviens. Si ça t'agace, active **Stay open in the background** dans **Paramètres → Système et appareil → Memory and performance**. Neconyan joue alors un son trop faible pour être entendu pendant ton absence, si bien que Chrome le traite comme un lecteur de musique et le laisse tranquille. Ça consomme un peu de batterie, affiche une notification multimédia et peut mettre en pause la musique d'autres applications, c'est pour ça que c'est désactivé par défaut. Pour l'instant, je ne l'ai testé que dans un navigateur de téléphone émulé, pas sur un vrai téléphone, alors dis-moi si ton téléphone l'ignore.

<a id="opening-it-on-your-phone"></a>

### L'ouvrir sur ton téléphone

Si Neconyan tourne sur ton ordinateur, ton téléphone peut s'en servir aussi, à condition que les deux soient sur le même Wi-Fi. C'est aussi la solution sur iPhone si tu préfères ne pas installer l'[application iPhone](#iphone-app) par sideloading.

Les deux navigateurs utilisent les mêmes données. Si tu as plutôt besoin de déplacer une installation hors ligne d'un appareil à l'autre, lis [Déplacer ses données d'un appareil à l'autre](../docs/data-portability.md), y compris la configuration du dossier de données avec GitHub, avant de copier ou de synchroniser le dossier.

1. Arrête Neconyan et ouvre `config.yaml` dans le dossier Neconyan avec n'importe quel éditeur de texte. Il apparaît après le premier démarrage. Remplace `listen: false` par `listen: true`.
2. Tant que tu y es, active un mot de passe, sinon n'importe qui sur ton Wi-Fi peut l'ouvrir. Mets `basicAuthMode: true`, puis change `username` et `password` sous `basicAuthUser`.
3. Redémarre Neconyan et trouve l'adresse locale de ton ordinateur.
   - **Windows :** lance `ipconfig` dans l'Invite de commandes et cherche **Adresse IPv4**.
   - **macOS :** maintiens la touche Option enfoncée et clique sur l'icône Wi-Fi dans la barre des menus, puis cherche **Adresse IP**.
   - **Linux :** lance `hostname -I`.
4. Dans le navigateur de ton téléphone, tape cette adresse avec `http://` devant et `:4433` derrière, par exemple `http://192.168.1.20:4433`.

Si Windows te demande s'il faut laisser passer Bun ou Node.js à travers le pare-feu, autorise-le sur les réseaux privés. Si ton téléphone affiche une page qui dit seulement **Interdit**, c'est que ton réseau attribue des adresses qui commencent par `10.`, et Neconyan les bloque par défaut. Ajoute cette ligne sous `whitelist:` dans `config.yaml`, puis redémarre Neconyan :

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Choisir entre Node.js et Bun, et autres options du lanceur</b></summary>

Chaque système a aussi des lanceurs séparés pour Node.js et pour Bun, si tu préfères choisir :

| Système | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Pour installer à la main, il te faut Node.js 20 ou plus récent :

```sh
npm install
npm run start:node
```

Bun 1.3.14 ou plus récent fonctionne aussi : lance `bun install`, puis `bun run start`, ou `bun run start:mobile` pour utiliser moins de mémoire. Laisse le fichier `.npmrc` du dépôt tel quel.

Pour empêcher une installation Git de se mettre à jour toute seule, définis `NECONYAN_AUTO_UPDATE=0` avant d'exécuter le lanceur.

</details>

<details>
<summary><b>Si quelque chose ne démarre pas</b></summary>

- **Windows dit qu'il a protégé ton ordinateur :** clique sur **Informations complémentaires**, puis sur **Exécuter quand même**. Il dit ça pour la plupart des lanceurs téléchargés.
- **macOS refuse d'ouvrir `Start.command` parce qu'il provient d'un développeur non identifié :** fais un clic droit dessus et choisis **Ouvrir**. Sur les versions récentes de macOS, va plutôt dans **Réglages Système → Confidentialité et sécurité** et clique sur **Ouvrir quand même**.
- **macOS ou Linux dit que le lanceur n'est pas exécutable :** lance ceci dans le dossier Neconyan.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Une installation Git ne se met plus à jour :** le lanceur saute les mises à jour si tu as modifié l'un des fichiers de Neconyan lui-même, et il t'explique pourquoi au démarrage. Tes discussions et `config.yaml` ne comptent pas.
- **Android :** Node.js est l'option par défaut dans Termux. Bun a besoin de deux paquets supplémentaires, que le lanceur Bun essaie d'installer pour toi. Si ça échoue, installe-les toi-même :

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Définis `GLIBC_ROOT` si ta glibc se trouve ailleurs que dans `$PREFIX/glibc`.

- **Le port 4433 est déjà pris :** passe `--port` avec un autre numéro, ou change le port dans `config.yaml`.

</details>

### Tu viens de SillyTavern ou de SillyBunny ?

La plupart de tes personnages, discussions, lorebooks, personas et préréglages devraient passer sans problème, mais je ne peux pas te promettre que tout suivra, et les extensions qui dépendent de la mise en page de SillyTavern auront peut-être besoin d'être corrigées.

- **Sauvegarde d'abord ton ancienne installation**, et garde cette sauvegarde jusqu'à ce que tu aies vérifié que tout fonctionne.
- **Donne à Neconyan son propre dossier de données.** Ne fais jamais pointer deux applications vers le même.

Neconyan crée son propre `config.yaml` et son propre dossier `data/` au premier lancement. Tes données personnelles, tes clés et les paquets installés ne font jamais partie de la version publiée.

<details>
<summary><b>Pour les développeurs</b></summary>

`main` contient les instantanés des versions publiées, et c'est sur `staging` que le travail se fait. Pour tes tests, utilise une copie de travail et un dossier de données à part, pour que tes discussions de tous les jours n'y soient pas mêlées.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Les tests de navigateur se trouvent dans `tests/` et tournent sur un serveur jetable : donne à `NECONYAN_TEST_BASE_URL` l'adresse de ce serveur (par défaut `http://127.0.0.1:4433`). Compile le frontend avant de lancer les tests, et redémarre le serveur après chaque recompilation. Les captures d'écran temporaires, les rapports de tests, les fichiers de build et les dossiers d'exécution locaux ne vont pas dans les commits.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Crédits">
</p>

Neconyan repose sur le travail de toutes les personnes derrière SillyTavern et SillyBunny ; rien de tout ça n'existerait sans elles. Les outils inclus et les projets dont ils viennent sont crédités dans [la liste des outils inclus](../docs/neconyan-native-tools.md).

Créé par [Platberlitz](https://github.com/platberlitz). Sous licence [GNU AGPL v3](../LICENSE), alors conserve les mentions et les licences si tu le redistribues.
