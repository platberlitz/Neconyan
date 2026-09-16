import { accountStorage } from './util/AccountStorage.js';

const ASSISTANTS = ['miso', 'taro', 'nori'];
const GENDERS = ['male', 'female', 'neutral'];
const ART_VERSION = '20260916-art4';

export function getAssistantGender(personality) {
    const gender = accountStorage.getState()[`neconyanAssistantGender:${personality}`];
    return GENDERS.includes(gender) ? gender : 'neutral';
}

export function setAssistantGender(personality, gender) {
    if (!ASSISTANTS.includes(personality) || !GENDERS.includes(gender)) return;
    accountStorage.setItem(`neconyanAssistantGender:${personality}`, gender);
    window.dispatchEvent(new CustomEvent('neconyan:assistant-gender-changed'));
}

export function getAssistantIconSrc(personality) {
    return ASSISTANTS.includes(personality)
        ? `img/neconyan/assistant-icons/${personality}-${getAssistantGender(personality)}.png?v=${ART_VERSION}`
        : 'img/neconyan-icon-192.png';
}

export function getAssistantTourSrc(image) {
    return image.replace(/(tour-\d{2}-(miso|taro|nori)-[a-z-]+)\.webp(?:\?.*)?$/, (_, scene, personality) =>
        `${scene}-${getAssistantGender(personality)}.webp?v=${ART_VERSION}`);
}
