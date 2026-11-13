<!-- Translated from README.md at commit 19874db1 (Neconyan 1.5.4). Keep the structure in step with the English README. -->

# Neconyan~

La dernière version est la [1.5.4](https://github.com/platberlitz/Neconyan/releases/tag/v1.5.4).

**Lire dans ta langue :** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Cette traduction peut avoir du retard. Le [README anglais](../README.md) est à jour.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - L'interface de RP pour LLM la plus mignonne">
</p>

Neconyan, c'est mon fork félin de [SillyTavern](https://github.com/SillyTavern/SillyTavern) et de [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), pour discuter et faire du jeu de rôle avec des personnages IA, sur ordinateur ou sur téléphone. Tu apportes ta propre clé API ou ton propre modèle local : l'appli n'inclut ni accès à un modèle ni crédits.

**[Télécharger Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[Lire le manuel](https://platberlitz.github.io/neconyan-docs/)** · **[Obtenir de l'aide](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> Tout le code ici est généré par un LLM ou écrit avec l'aide d'un LLM. Tous les prompts et tous les agents livrés avec Neconyan sont écrits par des humains.

## Qu'y a-t-il dedans ?

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Pourquoi Neconyan ?">
</p>

- **Quatre façons de discuter :** le Jeu de rôle classique, Conversation façon messagerie, un fil social appelé Meower, et le Mode histoire pour la prose continue.
- **Une mise en page pensée pour le téléphone**, avec des commandes qui portent un intitulé, une barre de discussion en bas de l'écran et un menu coulissant. **Simple Mode** masque les commandes les moins utilisées jusqu'à ce que tu en aies envie.
- **Mewmory** retient les événements et les personnages de l'histoire. Les **Agents** peuvent tenir des suivis à jour, vérifier une réponse ou rédiger à part une Note du compagnon.
- **Catelier** t'aide à écrire des cartes de personnage et des lorebooks. Les **Carnets** gardent tes notes à portée de main, et **Scratchpad** te donne une discussion à part pour parler de tes idées.
- **Miso, Taro et Nori** t'aident à retrouver des choses et peuvent effectuer les modifications prises en charge, avec ta permission.
- **Device sync** déplace des données choisies entre des installations distinctes, avec des fichiers chiffrés, WebDAV, des GitHub Gists secrets ou un appairage direct. Les transferts ne se lancent que quand tu le demandes.
- **Des thèmes, des couleurs d'accent et des chats.** Pas mal de chats. Tu peux les masquer, même si je ne vois pas pourquoi tu voudrais faire ça.

Tes cartes de personnage, tes discussions, tes lorebooks et tes préréglages utilisent les formats familiers de SillyTavern. Il n'y a aucune télémétrie. Certaines fonctions et extensions du projet d'origine se comportent différemment ici ; je ne reprends que ce qui m'intéresse. La [liste des outils inclus](../docs/neconyan-native-tools.md) crédite les projets fournis avec Neconyan.

## Jette un œil

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modes">
</p>

Des captures d'écran sur ordinateur et sur téléphone de la version 1.5.4, réalisées avec des discussions et des notes de démo et avec les assistants inclus.

### Accueil

Choisis un personnage, connecte un modèle ou dis bonjour à un assistant.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="L'Accueil sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="L'Accueil sur un téléphone"></td>
</tr></table>

### Jeu de rôle

Écris une scène, essaie une autre réponse ou reprends une ancienne discussion.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Le Jeu de rôle sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Le Jeu de rôle sur un téléphone"></td>
</tr></table>

### Catelier

Travaille sur un brouillon de personnage, demande de l'aide pour écrire et relis les changements avant de l'enregistrer dans ta bibliothèque.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="Catelier sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="Catelier sur un téléphone"></td>
</tr></table>

### Agents

Choisis un agent, décide quand il s'exécute et donne-lui une connexion. Je commencerais par un seul plutôt que d'activer la moitié de la bibliothèque d'un coup.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-agents.webp" alt="Les Agents sur ordinateur, avec des agents de réponse et leurs commandes"></td>
  <td width="28%"><img src="../docs/readme/phone-agents.webp" alt="Les Agents sur un téléphone"></td>
</tr></table>

### Proofreader post-génération

Proofreader vérifie une réponse après son arrivée. Il peut peaufiner la prose et la mise en forme sans demander au modèle principal de réécrire la scène. Ouvre **Modifications de l'agent** pour comparer la modification et l'annuler si tu préfères l'original.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-proofreader.webp" alt="Historique des modifications de Proofreader sur ordinateur, comparant la réponse d'origine et sa version modifiée"></td>
  <td width="28%"><img src="../docs/readme/phone-proofreader.webp" alt="Historique des modifications de Proofreader sur un téléphone"></td>
</tr></table>

Cet exemple mis en scène fait passer une réponse type fixe par le vrai processus des Agents. En usage normal, c'est ton modèle connecté qui écrit les modifications, et chaque passage peut coûter une requête de plus. [Agents et Compagnons dans le manuel](https://platberlitz.github.io/neconyan-docs/helpers/agents/).

<details>
<summary><b>Plus de captures d'écran : Simple Mode, Conversation, Meower, Mode histoire, Carnets, Scratchpad et Device sync</b></summary>

### Simple Mode

Moins de commandes le temps de prendre tes marques. **Show all features** dans la barre latérale les fait revenir ; rien n'est désactivé.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Mode sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Mode sur un téléphone"></td>
</tr></table>

### Conversation

Envoie des messages à tes personnages, crée des discussions de groupe et laisse-les être occupés ou hors ligne.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Conversation sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Conversation sur un téléphone"></td>
</tr></table>

### Meower

Un fil social où tes personnages publient, répondent et lancent des sondages.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower sur un téléphone"></td>
</tr></table>

### Mode histoire

Lis ta discussion sous forme de prose continue.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Le Mode histoire sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Le Mode histoire sur un téléphone"></td>
</tr></table>

### Carnets

Garde des plans de scène, des lieux et des journaux de session à côté de tes discussions.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Les Carnets sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Les Carnets sur un téléphone"></td>
</tr></table>

### Scratchpad

Parle de l'histoire avec un assistant ou avec une table ronde de personnages, sans verser leur échange dans la discussion principale.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad sur un téléphone"></td>
</tr></table>

### Device sync

Déplace des bibliothèques choisies entre des installations distinctes. Choisis des fichiers chiffrés, WebDAV, un GitHub Gist secret ou un appairage direct ; les transferts démarrent quand tu le demandes. [Configuration et récupération dans le manuel](https://platberlitz.github.io/neconyan-docs/help/device-sync/).

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-device-sync.webp" alt="Les réglages de Device sync sur ordinateur"></td>
  <td width="28%"><img src="../docs/readme/phone-device-sync.webp" alt="Les réglages de Device sync sur un téléphone"></td>
</tr></table>

</details>

## Pour commencer

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Bien démarrer">
</p>

### Sur un ordinateur

1. Télécharge le fichier qui se termine par **-source.zip** depuis la [dernière version](https://github.com/platberlitz/Neconyan/releases/latest). Décompresse-le d'abord ; sous Windows, fais un clic droit et choisis **Extraire tout**.
2. Ouvre le dossier. Lance **Start.bat** sous Windows, **Start.command** sous macOS, ou **bash start.sh** dans un terminal sous Linux.
3. Laisse quelques minutes au premier démarrage pour installer ce dont il a besoin. Garde la fenêtre du terminal ouverte tant que tu utilises Neconyan.
4. Ton navigateur devrait s'ouvrir tout seul. Sinon, va sur **http://127.0.0.1:4433/**.
5. Ouvre **Connexions**, choisis ton fournisseur et ton modèle, puis saisis ta clé API ou l'adresse de ton modèle local. Ensuite, ouvre un personnage ou un assistant sur l'Accueil.

La prochaine fois, relance le même lanceur. Pour arrêter Neconyan, appuie sur **Ctrl+C** dans son terminal.

Tu préfères Git ? Clone le dépôt, puis utilise le même lanceur :

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[Installation sur ordinateur et problèmes de démarrage courants](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Application Android

Télécharge le fichier **-android-arm64.apk** depuis la [dernière version](https://github.com/platberlitz/Neconyan/releases/latest) et ouvre-le. Autorise l'installation depuis ton navigateur si Android te le demande. Il te faut **Android 11 ou plus récent**, **Android System WebView 124 ou plus récent** et environ **2 GiB** d'espace libre.

L'application tourne sur le téléphone, sans Termux ni ordinateur. Laisse-lui le temps de tout décompresser à la première ouverture, puis configure **Connexions**. Installe les mises à jour par-dessus l'application existante pour garder tes discussions.

[Installation sur Android](https://platberlitz.github.io/neconyan-docs/start/android/) · [Instructions de compilation](../android/README.md)

### Application iPhone

Télécharge le fichier **-ios-unsigned.ipa** depuis la [dernière version](https://github.com/platberlitz/Neconyan/releases/latest), puis installe-le avec un outil de sideloading comme [iloader](https://github.com/nab138/iloader). Il te faut **iOS 17 ou plus récent**. L'application garde son serveur et tes discussions sur le téléphone ; elle n'est pas sur l'App Store.

Avec un compte Apple gratuit, il faut signer à nouveau l'application tous les sept jours, et tu ne peux installer que trois applications par sideloading. Installe les mises à jour par-dessus l'application existante en utilisant le même compte Apple. **Supprimer l'application supprime ses données**, alors exporte d'abord une sauvegarde.

[Installation sur iPhone et limites](../ios/README.md)

### Autres façons d'utiliser ton téléphone

- **Android avec Termux :** suis le [guide Termux](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux) si tu préfères un terminal ou si ton téléphone est plus ancien.
- **Utiliser l'installation d'un ordinateur :** suis le [guide pour le même Wi-Fi](https://platberlitz.github.io/neconyan-docs/start/phone/). Les deux appareils utilisent les mêmes discussions enregistrées ; garde l'ordinateur allumé.

## Mises à jour, sauvegardes et déplacement de tes discussions

Ouvre **Serveur → Mises à jour et redémarrage → Vérifier les mises à jour**. Les installations Git et celles par ZIP source prises en charge proposent **Mettre à jour et redémarrer**. Android propose **Update APK** et te demande d'approuver l'installation. Les anciennes copies ZIP sans outil de mise à jour demandent un [déplacement manuel vers le dossier plus récent](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation).

Les installations Git cherchent aussi des mises à jour au lancement. Les modifications que tu as apportées aux fichiers de l'application elle-même peuvent bloquer une mise à jour automatique ; tes discussions et tes réglages ne comptent pas.

Tu viens de SillyTavern ou de SillyBunny ? **Fais d'abord une sauvegarde**, donne à Neconyan son propre dossier de données, puis suis [Importer tes données](https://platberlitz.github.io/neconyan-docs/start/imports/). Vérifie tes personnages et tes discussions avant de supprimer quoi que ce soit. Certaines extensions pourraient avoir besoin d'être ajustées.

[Sauvegardes et restauration](https://platberlitz.github.io/neconyan-docs/help/backups/) · [Déplacer ses données d'un appareil à l'autre](../docs/data-portability.md)

## Besoin d'un coup de main ?

Je commencerais par le [manuel](https://platberlitz.github.io/neconyan-docs/), ou je demanderais à Miso, Taro ou Nori sur l'Accueil. Ils peuvent se tromper, alors vérifie leurs conseils avant de faire une modification que tu ne pourras pas annuler.

Si tu ne trouves pas un réglage, essaie **Recherche** dans la barre latérale. En cas d'erreur, utilise le [guide de dépannage](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) ou [ouvre un ticket](https://github.com/platberlitz/Neconyan/issues) en indiquant ce que tu étais en train de faire et l'erreur affichée.

## Crédits

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Crédits">
</p>

Neconyan repose sur le travail de toutes les personnes derrière SillyTavern et SillyBunny ; rien de tout ça n'existerait sans elles. La [liste des outils inclus](../docs/neconyan-native-tools.md) crédite leurs auteurs d'origine.

Créé par [Platberlitz](https://github.com/platberlitz). Sous licence [GNU AGPL v3](../LICENSE). Conserve les mentions et les licences si tu le redistribues.

Un remerciement tout spécial à **El Topo**, mon principal soutien et contributeur. J'apprécie vraiment tout le travail que tu as consacré à Neconyan.
