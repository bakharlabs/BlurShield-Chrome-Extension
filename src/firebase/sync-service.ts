// Cloud sync service for blur data
import { doc, setDoc, getDoc, collection, getDocs } from "firebase/firestore";
import { db } from "./firebase-config";
import { extensionAuthService as authService } from "./extension-auth-service";

export interface BlurData {
  selector: string;
  type: "element" | "area" | "text";
  text?: string;
  timestamp: number;
  coords?: { x: number; y: number; width: number; height: number };
}

export interface SiteBlurData {
  url: string;
  blurs: BlurData[];
  lastUpdated: number;
}

class SyncService {
  // Save blur data to Firestore
  async saveBlurData(url: string, blurData: BlurData[]): Promise<void> {
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error("User not authenticated");
    }

    try {
      const docRef = doc(db, "users", user.uid, "sites", this.getUrlKey(url));
      const siteData: SiteBlurData = {
        url,
        blurs: blurData,
        lastUpdated: Date.now(),
      };

      await setDoc(docRef, siteData);
      console.log("Blur data saved to cloud:", url);
    } catch (error) {
      console.error("Error saving blur data:", error);
      throw error;
    }
  }

  // Load blur data from Firestore
  async loadBlurData(url: string): Promise<BlurData[]> {
    const user = authService.getCurrentUser();
    if (!user) {
      return [];
    }

    try {
      const docRef = doc(db, "users", user.uid, "sites", this.getUrlKey(url));
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const data = docSnap.data() as SiteBlurData;
        console.log("Blur data loaded from cloud:", url, data.blurs.length);
        return data.blurs;
      }
      return [];
    } catch (error) {
      console.error("Error loading blur data:", error);
      return [];
    }
  }

  // Get all sites with blur data for current user
  async getAllSites(): Promise<SiteBlurData[]> {
    const user = authService.getCurrentUser();
    if (!user) {
      return [];
    }

    try {
      const sitesRef = collection(db, "users", user.uid, "sites");
      const querySnapshot = await getDocs(sitesRef);

      const sites: SiteBlurData[] = [];
      querySnapshot.forEach((doc) => {
        sites.push(doc.data() as SiteBlurData);
      });

      return sites;
    } catch (error) {
      console.error("Error getting all sites:", error);
      return [];
    }
  }

  // Convert URL to Firestore document key
  private getUrlKey(url: string): string {
    return btoa(url).replace(/[^a-zA-Z0-9]/g, "_");
  }
}

export const syncService = new SyncService();
export default syncService;
